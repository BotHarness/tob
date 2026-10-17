import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ClientError, parseInstance, type InstanceConfig } from "../../../packages/contracts/instance.ts";
export type Session = { version: 1; binding: string; userId: string | null; accessToken: string; refreshToken: string };
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export class Store {
  root: string;
  constructor(root: string) {
    if (!isAbsolute(root) || typeof process.getuid !== "function") throw new ClientError("PRIVATE_POSIX_STORE_REQUIRED");
    this.root = resolve(root);
    for (let p = this.root;; p = dirname(p)) {
      try { if (lstatSync(p).isSymbolicLink()) throw new ClientError("SYMLINK_REFUSED"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (p === dirname(p)) break;
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.check(this.root, true);
    for (const d of ["instances", "sessions", "locks"]) { mkdirSync(join(this.root, d), { recursive: true, mode: 0o700 }); this.check(join(this.root, d), true); }
  }
  private check(path: string, directory = false) {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid!() || (s.mode & 0o077)) throw new ClientError("INSECURE_CLI_STORE");
    return s;
  }
  private file(area: string, id: string) { return join(this.root, area, digest(id) + ".json"); }
  private read(path: string): unknown | undefined {
    try { this.check(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (fstatSync(fd).size > 65536) throw new ClientError("CLI_STATE_INVALID"); return JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new ClientError("CLI_STATE_INVALID"); } finally { closeSync(fd); }
  }
  private write(path: string, value: unknown) {
    if (existsSync(path)) this.check(path);
    const temp = path + "." + randomUUID();
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const path = this.file("locks", id);
    let fd: number;
    const acquire = () => openSync(path, "wx", 0o600);
    try { fd = acquire(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const old = this.read(path) as { pid?: unknown } | undefined;
      if (!old || typeof old.pid !== "number" || !Number.isSafeInteger(old.pid) || old.pid <= 0) throw new ClientError("SESSION_BUSY");
      try { process.kill(old.pid, 0); throw new ClientError("SESSION_BUSY"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw new ClientError("SESSION_BUSY"); }
      // A dead owner's lock can be reclaimed; never steal from a live process.
      const previous = this.check(path);
      if ((this.read(path) as { pid: number }).pid !== old.pid || lstatSync(path).ino !== previous.ino) throw new ClientError("SESSION_BUSY");
      unlinkSync(path);
      try { fd = acquire(); } catch { throw new ClientError("SESSION_BUSY"); }
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); return await action(); }
    finally { closeSync(fd); unlinkSync(path); }
  }
  configs(): InstanceConfig[] { return readdirSync(join(this.root, "instances")).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => parseInstance(this.read(join(this.root, "instances", n)))); }
  config(id: string) { const v = this.read(this.file("instances", id)); return v === undefined ? undefined : parseInstance(v); }
  putConfig(c: InstanceConfig) { this.write(this.file("instances", c.instanceId), c); }
  session(id: string): Session | undefined {
    const v = this.read(this.file("sessions", id)) as Session | undefined;
    if (v === undefined) return undefined;
    if (v.version !== 1 || typeof v.binding !== "string" || !/^[a-f0-9]{64}$/.test(v.binding) || (v.userId !== null && (typeof v.userId !== "string" || !/^user_[A-Za-z0-9]+$/.test(v.userId))) || typeof v.accessToken !== "string" || !v.accessToken || v.accessToken.length > 16384 || typeof v.refreshToken !== "string" || !v.refreshToken || v.refreshToken.length > 16384) throw new ClientError("CLI_STATE_INVALID");
    return v;
  }
  putSession(id: string, s: Session) { this.write(this.file("sessions", id), s); }
  clearSession(id: string) { const path = this.file("sessions", id); try { this.check(path); unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
}
export function readImport(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.size > 16384) throw new ClientError("INVALID_INSTANCE_CONFIG"); return parseInstance(JSON.parse(readFileSync(fd, "utf8"))); }
  catch { throw new ClientError("INVALID_INSTANCE_CONFIG"); } finally { closeSync(fd); }
}
