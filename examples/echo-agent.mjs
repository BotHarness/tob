#!/usr/bin/env node
// No DSH, model, shell execution, listening port or Human session is required.
import { readAgentFile } from '../apps/cli/lib/agent.ts';
import { checkDiscovery, request, responseJson } from '../packages/client/connection.ts';
import { ClientError } from '../packages/contracts/instance.ts';
export async function echoOnce(file, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw new ClientError('INVALID_CURSOR');
  const {config, actorId, channelId, secret} = readAgentFile(file);
  await checkDiscovery(config);
  const url = config.server + '/api/agent-channels/' + channelId + '/messages';
  const headers = {Authorization: 'Bearer tob_agent_' + actorId + '.' + secret, 'Content-Type':'application/json'};
  const call = async(init, suffix = '') => {
    const r = await request(url + suffix, {...init, headers:{...headers, ...init?.headers}});
    const value = await responseJson(r);
    if (!r.ok) throw new ClientError(typeof value.error?.code === 'string' && /^[A-Z_]+$/.test(value.error.code) ? value.error.code : 'AGENT_UNAVAILABLE');
    return value;
  };
  const page = await call({}, '?after=' + after);
  if (!Array.isArray(page.messages) || page.messages.length > 50 || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < after || typeof page.hasMore !== 'boolean') throw new ClientError('INVALID_RESPONSE');
  let replies = 0;
  for (const message of page.messages) {
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= after || typeof message.text !== 'string' || !['human','agent'].includes(message.authorType)) throw new ClientError('INVALID_RESPONSE');
    // Only an explicit harmless echo request from a Human can trigger a reply.
    // Agent results never trigger other Agents. This is not work authorization.
    if (message.authorType !== 'human' || !message.text.startsWith('echo: ')) continue;
    const reply = await call({method:'POST', headers:{'Idempotency-Key':'echo-message-' + String(message.sequence).padStart(16,'0')}, body:JSON.stringify({text:'Echo: ' + message.text.slice(6,3990)})});
    if (reply.message?.authorId !== actorId || reply.message.authorType !== 'agent' || typeof reply.replayed !== 'boolean') throw new ClientError('INVALID_RESPONSE');
    if (!reply.replayed) replies++;
  }
  return {actorId, replies, nextCursor:page.nextCursor, hasMore:page.hasMore};
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    if (process.argv[2] !== '--credential-file' || !process.argv[3] || (process.argv.length !== 4 && !(process.argv.length === 6 && process.argv[4] === '--after' && /^(0|[1-9][0-9]*)$/.test(process.argv[5])))) throw new ClientError('USAGE');
    console.log(JSON.stringify(await echoOnce(process.argv[3], Number(process.argv[5] ?? 0))));
  } catch(e) { console.log(JSON.stringify({error:{code:e instanceof ClientError ? e.code : 'AGENT_OPERATION_FAILED'}}));process.exitCode=1; }
}
