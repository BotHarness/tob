import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ClientError } from "../../../packages/contracts/instance.ts";
import { parseAgentCredential } from "../../../packages/contracts/agent.ts";
import { checkDiscovery, request, responseJson } from "../../../packages/client/connection.ts";

export function readPrivateJson(path: string): unknown {
  if (!isAbsolute(path) || typeof process.getuid !== "function") throw new ClientError("PRIVATE_CREDENTIAL_FILE_REQUIRED");
  for (let p = resolve(path);; p = dirname(p)) {
    if (lstatSync(p).isSymbolicLink()) throw new ClientError("SYMLINK_REFUSED");
    if (p === dirname(p)) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 20000) throw new ClientError("PRIVATE_CREDENTIAL_FILE_REQUIRED");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
export const readAgentFile = (path: string) => parseAgentCredential(readPrivateJson(path));
export async function agentCommand(args: string[], signal?: AbortSignal) {
  const command = args[1]; const options: Record<string, string> = {};
  if (!["history", "send"].includes(command)) throw new ClientError("USAGE");
  for (let n = 2; n < args.length; n += 2) {
    if (!["--credential-file", "--after", "--text-file", "--operation"].includes(args[n]) || args[n+1] === undefined || options[args[n]] !== undefined) throw new ClientError("USAGE");
    options[args[n]] = args[n+1];
  }
  if (!options["--credential-file"]) throw new ClientError("USAGE");
  const credential = readAgentFile(options["--credential-file"]);
  const { config, actorId, channelId, secret } = credential;
  await checkDiscovery(config, signal);
  const headers = { Authorization: "Bearer tob_agent_" + actorId + "." + secret, "Content-Type": "application/json" };
  const base = config.server + "/api/agent-channels/" + channelId + "/messages";
  let response: Response;
  if (command === "history") response = await request(base + "?after=" + encodeURIComponent(options["--after"] ?? "0"), { headers }, signal);
  else {
    if (!options["--text-file"] || !/^[A-Za-z0-9_-]{16,100}$/.test(options["--operation"] ?? "")) throw new ClientError("USAGE");
    let text: string; try { text = readFileSync(options["--text-file"], "utf8"); } catch { throw new ClientError("MESSAGE_FILE_UNREADABLE"); }
    if (!text.trim() || text.length > 4000) throw new ClientError("INVALID_CHANNEL_INPUT");
    response = await request(base, { method: "POST", headers: { ...headers, "Idempotency-Key": options["--operation"] }, body: JSON.stringify({ text }) }, signal);
  }
  const value = await responseJson(response);
  if (!response.ok) {
    const code = (value.error as { code?: unknown })?.code;
    throw new ClientError(typeof code === "string" && /^[A-Z_]{1,80}$/.test(code) ? code : "AGENT_UNAVAILABLE");
  }
  return value;
}
