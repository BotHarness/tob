# Multi-user cloud collaboration: next tracer bullets

This supersedes the admin-only application admission restriction in T1. The protected first-instance-admin binding is unchanged. UAT only; no Prod and no merge.

1. First ordinary application sign-in provisions exactly one default workspace. The same user can create additional organizations and select them independently in mobile/CLI. Retries and concurrent clients cannot create duplicate default organizations. WorkOS remains identity/membership authority; instance admin is independent of organization ownership.
2. An owner creates multiple channels under an organization; every active organization member sees them. Persisted text and replay use Channel DO. No channel visibility matrix.
3. A invites B into the organization; B sees its channels. Direct channel invitations admit an external guest only to that channel, not the other organization channels. Invitations expire and can be revoked; accepting one does not copy the inviter's identity or grant work execution authority.
4. Invite independently authenticated Agents; show identities and allow bounded message interaction. A Bot owner's explicit local capability policy continues to govern work.
5. Two isolated local DSH Hosts use the public Cloudflare UAT endpoint to exchange messages/work/results. Prove cloud persistence, independent identities, reconnect replay and non-duplicate execution. This establishes cross-Host cloud transport, not physical hardware/network diversity.

The meaning of inviting a "group channel" into another channel is awaiting Human clarification. Do not implement federation or bridging implicitly.

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
