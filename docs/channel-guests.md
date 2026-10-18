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

The native UAT path and independent CLI readback are now verified below. Source tests alone do not establish that result. Android, physical phone and Human QA remain unqualified. No Prod changes or merge.

## Real UAT service/CLI verification — 2026-10-18 JST

Runtime `6226ec3af48d7c446c95421290aaa280ce8a7490`, Worker version `b8e22111-d975-4ad6-81b9-6d56e32fb84c`, schema 5/4/2. Dedicated synthetic A/B accounts: A issued a direct invitation into its default workspace's test channel; B accepted without changing its selected organization. B's org list excluded A's workspace; selecting it and reading a sibling channel were refused. The pre-join message remained hidden; B's one idempotent reply was read back with the exact author by A's independent CLI. Revoke denied old-session read/send; a replacement invitation started a new history floor and refused replay of the previous send. Both test grants were revoked, and A's prior selected workspace restored. This is real public HTTP/CLI evidence, not a native phone pass or email-delivery test.

## Native UAT verification — 2026-10-18 JST

[DeepSeekBot Draft #2150](https://github.com/BotHarness/DeepSeekBot/pull/2150) final runtime `bc08a47e6f060fe6caa6b879c4b2464e12d69e05`: phone owner invited B, B accepted without organization membership/selection change and sent a message read by owner CLI. Rejoin used a new floor; refresh/cold restart preserved access only to the new message. Revocation refused the old phone session and independent CLI. Owner phone also revoked an accepted grant at maximum text size. Six form and composer size/theme cases passed after correcting title and keyboard defects. Independent phone logout revoked only its own session; CLI sessions were retained.

The linked PR evidence records intermediate runtime provenance and first failures. This is synthetic-user iOS Simulator proof, not Hosted AuthKit, email delivery, Android, physical phone or Human QA. Shared Simulator resources were restored and released.

## Confirmed invitation scope

The Human clarified that a channel-level invitation admits its recipient only to that channel. It does not grant organization membership, organization directory access or access to other channels. “Invite group channel” is not a group-to-group bridge or federation requirement. Existing organization members still see all organization channels; the guest grant is the only additional scope needed for this slice.

## Workspace directory projection

`GET /api/guest-channels` now includes `organizationName` on each currently authorized channel. The service checks the current Channel DO grant and local organization before reading its name from Org DO. It never enumerates other organizations or adds WorkOS membership. `?organizationId=org_…` optionally narrows the same authorized projection; malformed IDs return 400 and unrelated organizations return no channels.

`node apps/cli/tob.mjs guest-channel list --server "$TOB_SERVER" --org "$TOB_ORG"` exposes the same filter. `--after` remains supported. Cursors advance through the recipient directory, so an empty page can still have a next cursor; clients must offer continuation until it is null. Revoked grants disappear on the next listing. No schema migration is needed.

Source verification: 62 Worker tests and 20 CLI tests pass, covering authorized metadata, filter, unrelated user/org and revocation. UAT runtime `bf6d896e813457382cd2bb2e7c74b22c03ba01ca` was deployed and read back; [formal CLI evidence](evidence/2026-10-18-workspace-directory-uat.json) verifies the authorized organization name, filter, unrelated-org empty result, absent org membership, sibling denial and revoked-channel removal. Only this run's synthetic invitation was revoked; existing CLI sessions were preserved. Mobile native drawer acceptance remains pending.
