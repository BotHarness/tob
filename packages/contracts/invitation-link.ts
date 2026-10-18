import { ClientError, serverOrigin } from './instance.ts';

// A locator for a recipient-bound invitation. Possession never grants membership.
export function invitationLink(server: string, invitationId: string): string {
  serverOrigin(server);
  if (!/^(?:invitation_[A-Za-z0-9]{1,120}|ci_[a-f0-9]{64})$/.test(invitationId))
    throw new ClientError('INVALID_INVITATION_LINK');
  return server + '/join?invitation=' + invitationId;
}
export function parseInvitationLink(raw: string) {
  try {
    if (raw.length > 2048 || raw !== raw.trim()) throw Error();
    const url = new URL(raw);
    const id = url.searchParams.get('invitation') ?? '';
    if (url.username || url.password || url.hash || url.pathname !== '/join' ||
      [...url.searchParams.keys()].length !== 1 || invitationLink(url.origin, id) !== raw)
      throw Error();
    return { server: url.origin, invitationId: id, guest: id.startsWith('ci_') };
  } catch { throw new ClientError('INVALID_INVITATION_LINK'); }
}
