import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AccessError, admitUser } from './auth/admission';
import { channelContext, operation } from './channels';
import { authenticatedAgent } from './agents';
import { access } from './organizations';
import {
  parseWorkInput,
  parseWorkResult,
  parseForwardInput,
  validRequestId,
} from '../../../packages/contracts/work';

const limit = bodyLimit({
  maxSize: 8000,
  onError: (c) => c.json({ error: { code: 'INVALID_WORK_INPUT' } }, 413),
});
async function parse<T>(request: Request, parser: (value: unknown) => T) {
  try {
    return parser(await request.json());
  } catch {
    throw new AccessError('INVALID_WORK_INPUT', 400);
  }
}
function checkId(id: string) {
  if (!validRequestId(id)) throw new AccessError('INVALID_WORK_INPUT', 400);
  return id;
}
export const humanWork = new Hono<{ Bindings: Env }>()
  .use('*', limit)
  .post('/:orgId/channels/:channelId/work-requests', async (c) => {
    const { channel, actor, member } = await channelContext(
      c.env,
      c.req.header('Authorization'),
      c.req.param('orgId'),
      c.req.param('channelId'),
    );
    const input = await parse(c.req.raw, parseWorkInput);
    const key = operation(c.req.header('Idempotency-Key'));
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([c.req.param('channelId'), actor.id, key])),
        ),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const result = await channel.requestWork(
      c.req.param('channelId'),
      actor,
      member.id,
      key,
      'wr_' + hash,
      input.targetActorId,
      input.expiresAt,
    );
    if ('error' in result)
      throw new AccessError(
        result.error,
        result.error === 'OPERATION_CONFLICT'
          ? 409
          : result.error === 'INVALID_WORK_EXPIRY'
            ? 400
            : 403,
      );
    return c.json(result);
  });
async function verifyWorkAccess(
  env: Env,
  ctx: {
    request: { requesterUserId: string };
    requesterMembershipId: string;
    organizationId: string;
    forwarder?: { ownerUserId: string; ownerMembershipId: string };
  },
) {
  try {
    await admitUser(ctx.request.requesterUserId, env);
    const member = await access(env, ctx.request.requesterUserId, ctx.organizationId);
    if (member.id !== ctx.requesterMembershipId)
      throw new AccessError('REQUESTER_ACCESS_DENIED', 403);
    if (ctx.forwarder) {
      await admitUser(ctx.forwarder.ownerUserId, env);
      const issuer = await access(env, ctx.forwarder.ownerUserId, ctx.organizationId);
      if (issuer.id !== ctx.forwarder.ownerMembershipId || issuer.role.slug !== 'owner')
        throw new AccessError('REQUESTER_ACCESS_DENIED', 403);
    }
  } catch (e) {
    if (e instanceof AccessError && e.status === 403)
      throw new AccessError('REQUESTER_ACCESS_DENIED', 403);
    throw e;
  }
}
export const agentWork = new Hono<{ Bindings: Env }>()
  .use('*', limit)
  .post('/:channelId/work-requests/:requestId/authorize', async (c) => {
    const id = checkId(c.req.param('requestId'));
    const { channel, actorId, secretHash } = await authenticatedAgent(
      c.env,
      c.req.header('Authorization'),
      c.req.param('channelId'),
    );
    const ctx = await channel.agentWorkContext(c.req.param('channelId'), actorId, secretHash, id);
    if (!ctx) throw new AccessError('WORK_ACCESS_DENIED', 403);
    await verifyWorkAccess(c.env, ctx);
    const result = await channel.authorizeWork(c.req.param('channelId'), actorId, secretHash, id);
    if ('error' in result && result.error) throw new AccessError(result.error, 403);
    return c.json(result);
  })
  .post('/:channelId/work-requests/:requestId/forward', async (c) => {
    const parentId = checkId(c.req.param('requestId'));
    const input = await parse(c.req.raw, parseForwardInput);
    const { channel, actorId, secretHash } = await authenticatedAgent(
      c.env,
      c.req.header('Authorization'),
      c.req.param('channelId'),
    );
    const ctx = await channel.agentWorkContext(
      c.req.param('channelId'),
      actorId,
      secretHash,
      parentId,
    );
    if (!ctx) throw new AccessError('WORK_ACCESS_DENIED', 403);
    await verifyWorkAccess(c.env, ctx);
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([c.req.param('channelId'), parentId, 'forward'])),
        ),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const result = await channel.forwardWork(
      c.req.param('channelId'),
      actorId,
      secretHash,
      parentId,
      'wr_' + hash,
      input.targetActorId,
    );
    if ('error' in result)
      throw new AccessError(result.error, result.error === 'OPERATION_CONFLICT' ? 409 : 403);
    return c.json(result);
  })
  .post('/:channelId/work-requests/:requestId/result', async (c) => {
    const id = checkId(c.req.param('requestId'));
    const result = await parse(c.req.raw, parseWorkResult);
    if (result.requestId !== id) throw new AccessError('INVALID_WORK_INPUT', 400);
    const { channel, actorId, secretHash } = await authenticatedAgent(
      c.env,
      c.req.header('Authorization'),
      c.req.param('channelId'),
    );
    const written = await channel.agentWorkResult(
      c.req.param('channelId'),
      actorId,
      secretHash,
      result,
    );
    if ('error' in written)
      throw new AccessError(written.error, written.error === 'OPERATION_CONFLICT' ? 409 : 403);
    return c.json(written);
  });
