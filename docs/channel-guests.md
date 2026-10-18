# Direct channel guests — UAT candidate

An organization owner invites an existing verified application user into one channel. Accepting creates a Channel DO guest grant, **not** a WorkOS organization membership. The guest opens that channel from a separate entry without selecting or joining its organization. Organization members continue to see all organization channels through their existing membership.

This is the next vertical slice after organization invitations. It does not implement complex channel visibility, Agent credentials, channel-to-channel invitations, email delivery or new-user registration. The initial recipient is an existing application user who opens their inbox. Creating an invitation is not proof that an email was delivered.

## Authority and recovery

- Current organization owners issue, list and revoke invitations; current recipient identity and verified provider email are checked on acceptance. The server binds the grant to the accepted user ID. A later email owner cannot inherit an accepted invitation.
- Channel DO persists invitations and grants. Pending invitations expire after seven days. Acceptance and the grant's message-sequence floor commit atomically in that DO. Retry returns the same grant and never advances its floor.
- A guest reads messages strictly after acceptance. Every read/send checks the current grant in the same DO operation. Revocation disables it immediately for subsequent requests, including old client sessions. Rejoining with a new invitation uses a new sequence floor; an old send operation cannot disclose messages from the earlier grant.
- D1 `channel_invitation_directory` is only a bounded recipient lookup projection. It cannot authorize a user. Results are checked against Channel DO and the enabled local organization. DO-first writes followed by D1 indexing can fail between stores: retrying the same issuance operation or acceptance repairs the index, without duplicate invitations or reset history. Accepted-user indexing is monotonic so a delayed pending index write cannot erase it.
- Repeating revocation of an older invitation cannot revoke a later replacement grant. A simultaneous second acceptance while already active is refused. Revoking a guest grant does not revoke separate organization membership.
- Migrations add D1 schema 5 and Channel schema 2; Org stays 4. No credentials or WorkOS membership copy enters these tables. Existing messages remain unchanged. The previous Worker ignores these additive tables; rollback removes guest functionality but does not undo persisted invitations or grants.

## Public interface and CLI

Owner routes (selected organization token and current owner role required):

- `POST/GET /api/organizations/:orgId/channels/:channelId/guest-invitations`
- `POST /api/organizations/:orgId/channels/:channelId/guest-invitations/:id/revoke`

Recipient/guest routes (independent application session; no host organization selection):

- `GET /api/channel-invitations`, `POST /api/channel-invitations/:id/accept`
- `GET /api/guest-channels`, `GET /api/guest-channels/:channelId`
- `GET/POST /api/guest-channels/:channelId/messages`

Lists are bounded and cursor-paginated. Message writes require a stable `Idempotency-Key`. No body-supplied author, role or user ID is accepted.

```sh
# A: select the owned workspace before issuing.
node apps/cli/tob.mjs channel-invite send --server "$TOB_SERVER" --channel "$TOB_CHANNEL" --email recipient@example.com --operation channel-invite-0001
node apps/cli/tob.mjs channel-invite list --server "$TOB_SERVER" --channel "$TOB_CHANNEL"
# B: use B's own config directory/session; no org use or join.
node apps/cli/tob.mjs channel-invite inbox --server "$TOB_SERVER"
node apps/cli/tob.mjs channel-invite accept --server "$TOB_SERVER" --id "$TOB_INVITATION"
node apps/cli/tob.mjs guest-channel list --server "$TOB_SERVER"
node apps/cli/tob.mjs guest-channel show --server "$TOB_SERVER" --id "$TOB_CHANNEL"
node apps/cli/tob.mjs guest-channel history --server "$TOB_SERVER" --id "$TOB_CHANNEL" --after 0
node apps/cli/tob.mjs guest-channel send --server "$TOB_SERVER" --id "$TOB_CHANNEL" --text-file ./message.txt --operation guest-message-0001
# A: revoke either pending invitation or accepted guest access.
node apps/cli/tob.mjs channel-invite revoke --server "$TOB_SERVER" --channel "$TOB_CHANNEL" --id "$TOB_INVITATION"
```

## Acceptance and current evidence

Source checks: workerd covers no organization membership creation, no sibling access, no pre-join history, forged body/recipient rejection, owner-role changes, verified email, expiry, revoke/rejoin, concurrent/repeated operations, DO eviction, D1 index failures and disabled organizations. CLI checks cover independent guest routes, current owner selection, stable operation keys and refusal propagation.

The complete slice still requires the phone owner invitation and recipient acceptance/channel interaction, real UAT CLI readback and boundary checks, native size/theme/keyboard evidence, and restoration of test sessions. Source tests alone are **not** a completed tracer bullet. No Prod changes or merge.
