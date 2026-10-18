# Multi-user cloud collaboration: next tracer bullets

This supersedes the admin-only application admission restriction in T1. The protected first-instance-admin binding is unchanged. UAT only; no Prod and no merge.

1. First ordinary application sign-in provisions exactly one default workspace. The same user can create additional organizations and select them independently in mobile/CLI. Retries and concurrent clients cannot create duplicate default organizations. WorkOS remains identity/membership authority; instance admin is independent of organization ownership.
2. An owner creates multiple channels under an organization; every active organization member sees them. Persisted text and replay use Channel DO. No channel visibility matrix.
3. A invites B into the organization; B sees its channels. Direct channel invitations admit an external guest only to that channel, not the other organization channels. Invitations expire and can be revoked; accepting one does not copy the inviter's identity or grant work execution authority.
4. Invite independently authenticated Agents; show identities and allow bounded message interaction. A Bot owner's explicit local capability policy continues to govern work.
5. Two isolated local DSH Hosts use the public Cloudflare UAT endpoint to exchange messages/work/results. Prove cloud persistence, independent identities, reconnect replay and non-duplicate execution. This establishes cross-Host cloud transport, not physical hardware/network diversity.

The Human confirmed that "group channel invitation" means inviting a recipient only to the selected channel. Acceptance must not create organization membership or reveal sibling channels. This is the existing direct-channel guest scope, not federation or a group-to-group bridge.

## First slice contract

`POST /api/onboarding` runs after authenticated sign-in and on explicit session checks. A fixed server-derived user operation provisions "My workspace" once; it cannot be selected by caller-provided user IDs. `GET /api/me` remains read-only. Existing instance deployments retain admin-only admission until a protected operator policy change enables authenticated users and additional org creation. WorkOS registration configuration remains a separate control; invitation-only registration can coexist with normal non-admin users.

Clients accept explicit `admin` or `user` instance roles. Application admission never grants instance administration. First-sign-in failures retain the authenticated session and show a retriable onboarding failure rather than silently claiming completion. Existing org-scoped selection remains independent per client. Runtime qualification is recorded separately below; this contract alone is not a pass.

The protected UAT operator command is `node tools/bootstrap/enable-users-uat.mjs PROFILE --confirm-multi-user`, after deploying schema 4. It independently checks Cloudflare database and Worker bindings, UAT origin, schema and successful active bootstrap binding; one version-conditional policy update is replayable. It does not change WorkOS signup. New/self-hosted instances still initialize closed; public signup requires the operator's separate identity-provider configuration. `tob onboard --server URL` retries CLI setup without another interactive login; CLI login invokes it automatically. Existing sessions may explicitly onboard. Mobile session checks invoke the same idempotent endpoint.

Migration 0003 preserves the singleton and bootstrap trigger while widening allowed admission/creation modes; it does not enable multi-user access by itself. Once enabled, rolling back to an admin-only Worker would deny normal users; restore operator policy deliberately before rollback or fix forward. The UAT readback is recorded below; this does not enable other instances.

## UAT first service/CLI verification — 2026-10-18 JST

- Worker `c4c8aa44fd86dcd53650440a8350442c20420938`; version `cc848bdb-d7cb-44cf-bbea-be1df39d11dc`; D1 schema 4 and Org schema 2.
- Before deployment/policy enablement, both dedicated ordinary users were denied. Protected operator enablement read back policy version 2 (`authenticated` / `all_users`); bootstrap binding unchanged. WorkOS public signup remains disabled.
- Two synthetic password-authenticated users each obtained a distinct default organization through the formal CLI. Repeating setup returned the same organization. A created an additional organization and selected first → second → first. A listed two workspaces; B listed only its own. B selection and direct read of A's workspaces were refused.
- The first run reached multi-workspace switching, but one B denial assertion received `NETWORK_UNAVAILABLE`. The failure was retained; a repeat with the same operation keys and existing identities passed every assertion. This is a transport interruption/retry, not evidence that an unavailable request was safely denied by policy.
- Local checks: 26 workerd, 20 Node/CLI/contracts and 2 wizard tests plus typecheck/build. Mobile source/driver/style checks: 26 plus typecheck. Native multiple-workspace evidence and new signup UI remain pending. Programmatic synthetic authentication does not claim Hosted AuthKit verification or real email delivery.
- Dedicated fixtures and three organizations are retained in UAT for subsequent invitation/channel tests. Credentials and provider details remain in private operator files; no secrets are published. No Prod changes or PR merges.

## UAT mobile continuation — 2026-10-18 JST

Mobile runtime `9f71dd3d9` passed on the sole shared Simulator, with service `c4c8aa44` and test driver `079832999`. Ordinary user A sees Signed in without an administrator label, replays its default workspace, creates a third workspace through the actual UI, switches default → third, and an independent formal CLI lists/selects the exact same organization. A has three workspaces and B has one. Cold restart retains selection; refresh rotates the phone session. Phone sign-out revokes its session and rejects its latest refresh, while independent CLI A/B remain usable. The phone credential fixture was removed after verification. Four workspaces remain for subsequent invitation/channel tests.

The fixture helper now handles WorkOS's organization-selection challenge for an existing multi-org synthetic user, selecting only a membership returned by WorkOS. Other challenges fail. This is test-only API authentication, not new Hosted AuthKit or email delivery evidence. Local Node/CLI/contracts now total 22 checks, alongside 26 workerd and 2 wizard tests. [Native captures, recordings and limits](https://github.com/BotHarness/DeepSeekBot/pull/2131) are in the stacked mobile PR. No channels, invitations, physical-device/Human acceptance, Prod or merge is claimed.

## Channel HTTP slice — UAT verification, 2026-10-18 JST

Service `b26150224a60808d89daf7e9cd8863faf26ed75f` (UAT version `f62d1003-7e9c-4924-a889-d06a27ec0427`, schemas D1/Org/Channel 4/3/1) and final mobile `5d2ef0fe8a13654a75779ea0320394b13c00764c` now exercise a real channel path. Formal CLI creates two channels and replays create/send operations without duplicates. The actual shared iOS Simulator creates two more, exchanges messages with an independent CLI session, and the CLI reads back all seven exact message bodies/newlines and sequences. A has three workspaces and four channels in the selected workspace; B has its own workspace and no channels.

Live WorkOS owner-to-member downgrade rejects channel creation with a stale owner JWT, while read/send remain allowed; the synthetic user's owner role was restored and verified. Cross-user and wrong-organization channel reads fail. Phone cold restart, refresh, own remote logout/latest-refresh rejection/local clearing and A/B CLI isolation passed. Temporary phone credentials were removed. WorkOS public registration settings, the Human bootstrap identity, Prod and merges were untouched.

Native verification found and fixed maximum-text keyboard occlusion and dark input contrast. A first repair check served old JS because CI-mode Metro disabled file watching; it is retained as a harness failure, not repair evidence. Final native evidence includes six text-size/theme cases with live draft/focus retention and a real send with the full action above the keyboard prediction bar. [Mobile PR #2138](https://github.com/BotHarness/DeepSeekBot/pull/2138) contains exact-version captures, recordings and limits; [service PR #19](https://github.com/BotHarness/tob/pull/19) contains the API/CLI implementation. Source checks: 30 workerd, 23 Node/CLI/contracts and 20 mobile client/style checks plus typechecks/CI.

This completes the narrow HTTP channel sub-slice, not T1/T2 or the overall goal. Invitations, direct channel guests, independently authenticated Agents, live WebSocket delivery/revocation, history rejoin/grants and the two-isolated-Host cloud path remain. Next: A invites B into an organization through the same public API/CLI and mobile surface; accepted B sees that organization's channels without receiving owner or instance-admin privileges. Direct channel invitations follow with a separate guest boundary. The meaning of inviting a group channel remains awaiting clarification; no implicit bridge/federation is authorized.

## Organization invitation continuation — UAT verification, 2026-10-18 JST

[Invitation slice](organization-invitations.md#native-uat-continuation--2026-10-18-jst) now has service/CLI and actual mobile evidence. A invites B, B accepts and reads organization-wide channels as member; pre-join history is hidden, post-join text is read by owner, and owner-only operations remain refused. Native revoke and session isolation passed. See [service #20](https://github.com/BotHarness/tob/pull/20) and [mobile #2146](https://github.com/BotHarness/DeepSeekBot/pull/2146). The next bounded behavior is a direct channel guest who can use that channel without seeing the rest of its organization. Agent identity and two-Host cloud communication follow; group-channel bridge meaning is still unanswered. Keep T1/T2 and the overall goal open.

## Next: direct channel guest candidate

[Channel guest contract and acceptance](channel-guests.md) now defines existing-user inbox acceptance without organization membership. Source tests cover per-channel isolation, sequence-based history, revoke/rejoin and DO→D1 recovery. Mobile, real UAT and cross-Host Agent proof remain separate gates; do not infer them from this service preparation.

## Channel guests qualified; next Agent interaction

[Channel guest native continuation](channel-guests.md#native-uat-verification--2026-10-18-jst) passed phone invite/accept/send, independent CLI boundaries, refresh/restart, revoked old-session refusal and owner revoke. [Agent interaction](channel-agents.md) is now the active sub-slice: independent channel-scoped identity and harmless reply, with credentials separate from local work authorization. Agent organization-wide membership, WebSocket, fixed work, two-Host communication and group-channel clarification remain outstanding.

## Fixed work request continuation

The channel credential/echo sub-slice is qualified in UAT and the phone. Next, [fixed health checks](agent-health-check.md) separate authenticated message requests from operator-granted local work. The initial check has a durable execution/result ledger and no arbitrary shell command. Phone/CLI and native UAT gates precede extending this owner into the two-isolated-Host path; WebSocket and group-channel bridge semantics remain separate.

## One-hop protocol qualified; DSH Host integration next

[Draft #24](https://github.com/BotHarness/tob/pull/24) adds [bounded forwarding](work-forwarding.md). UAT runtime864b16d preserved the original member/deadline/capability across A→B, returned B's result to the same channel, rejected local permission loss and second hops, and replayed without another execution. The cloud durably chooses execution or forwarding per parent. Public CLI/independent processes are qualified; DSH Messaging/Runtime binding, real model A and two isolated Hosts remain next. Do not count this preparation as completed T4 or the overall goal.
