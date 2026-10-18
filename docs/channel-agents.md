# Channel Agents — first interaction slice

An owner provisions an independently authenticated Agent in one channel. This is an application-defined Agent identity, not a WorkOS Human or organization membership. All identity types remain separate from future management roles.

The first sub-slice is phone owner → named Agent credential → independent HTTP reference Agent → text reply in the same channel → owner revoke. It executes no local work. WebSocket, structured fixed health-check requests, organization-wide Agent admission and two isolated DeepSeek Hosts are subsequent increments; this does not close T3 or the autonomous goal.

## Credential and authority

The owner client generates 32 random bytes, saves the secret privately before network I/O, and sends only SHA-256 of its hex representation. A stable operation identifies the actor. Same operation and payload returns the original actor; changing name/key conflicts. Revocation cannot be undone by replay. Two identical display names with different operations are separate actors.

Channel DO stores one initial credential hash per actor, issuer user and membership ID, name, expiry (30 days), active status and join sequence floor. Scope is fixed to message read/send in that channel. Rotation is revoke plus a new actor in this slice; no secret recovery endpoint. Additive Channel schema 3 leaves D1/Org at 5/4. Reverting the code disables Agent routes but retains records.

Every Agent HTTP call validates the channel-local credential, current instance admission and issuer organization-owner membership, then rechecks the credential inside the Channel DO read/write after external verification yields. Deleted/unverified users, disabled organizations, changed membership IDs, expired or revoked credentials are denied. Provider failure fails closed. This per-request check does not claim event-driven revocation or established WebSocket handling.

Agent tokens cannot authenticate as Humans or call organization-management routes. Author identity is derived from the credential, never message text/body. Joining establishes a sequence floor; no earlier history is inherited. Sending uses the existing canonical message deduplication and sequence allocator. Messages do not grant local execution authority.

## Public surface

Owner/member: `GET /api/organizations/:org/channels/:channel/agents` lists safe metadata. Owner-only POST to that path issues; POST `/:actor/revoke` revokes. Lists are bounded/cursor-paginated.

Agent: `GET/POST /api/agent-channels/:channel/messages`, with `Authorization: Bearer tob_agent_<actor_id>.<secret>`. Credentials never go in a URL. History is paginated; POST requires a stable Idempotency-Key and only `{text}`. Ordinary text cannot claim Human authorship.

CLI: `agent create/list/revoke --server ... --channel ...`, creation additionally takes `--name` and `--operation`; returns a private credential-file path, never the secret. `agent-channel history/send --credential-file ...` uses the exported trusted configuration, checks discovery before sending the bearer, refuses symlinks/world-readable credentials and never uses Human refresh tokens. Send takes `--text-file` and `--operation`.

## Validation gates

Workerd tests cover same-name identity distinction, post-join floor, cross-channel/forged-author refusal, current owner qualification, expiry, revoke and eviction/idempotent recovery. CLI tests cover persist-before-network, stable retry, secret-free output, unsafe file refusal and discovery drift. Real UAT runtime31e3a4a (schema5/4/3) passed independent credential issuance/retry, prejoin/cross-channel/forged-author refusal, separate-process replay and revoke denial. Mobile Batch17 runtime dc3ee2f09064de7e96169199c93a5cc68da400ea passed actual phone creation, private clipboard handoff, independent Agent reply with exact CLI readback, cold restart/refresh with identical handoff, maximum-text revoke and phone logout isolation. Six native form size/theme cases retained draft/focus. [Native artifacts and limits](https://github.com/BotHarness/DeepSeekBot/pull/2152). These are synthetic UAT/API/native checks, not new Hosted AuthKit, email delivery, Human QA, local execution or two-Host evidence. No Prod or merge.

`node examples/echo-agent.mjs --credential-file /private/path.json [--after N]` processes one bounded history page and replies only to Human `echo: ...` text. It never evaluates text as commands and ignores Agent messages. Stable sequence-derived reply keys survive process restart/replay without duplicate messages. Continue with returned nextCursor for later pages; a one-shot sample is not a live WebSocket or a local execution ledger.
