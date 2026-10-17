import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
export function privateProfile(path) {
  if (!path || !isAbsolute(path)) throw new Error('ABSOLUTE_PROFILE_REQUIRED');
  for (let current = path;; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
    if (dirname(current) === current) break;
  }
  const dir = lstatSync(path);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('PRIVATE_PROFILE_REQUIRED');
  const read = name => {
    if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('INVALID_FILE');
    const file = join(path, name); const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('PRIVATE_FILE_REQUIRED');
    return readFileSync(file, 'utf8');
  };
  return {
    json: name => JSON.parse(read(name)),
    env: name => {
      const values = {};
      for (const line of read(name).split('\n').filter(line => line && !line.startsWith('#'))) {
        const match = /^([A-Z_]+)=([^\r\n]*)$/.exec(line);
        if (!match || Object.hasOwn(values, match[1])) throw new Error('INVALID_PRIVATE_CONFIG');
        values[match[1]] = match[2];
      }
      return values;
    },
    createJson: (name, value) => {
      if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('INVALID_FILE');
      writeFileSync(join(path, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    },
  };
}
export async function jsonRequest(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`REMOTE_HTTP_${response.status}`);
  return response.json();
}
