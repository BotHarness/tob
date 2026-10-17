# Organization invitations — bounded UAT slice

Owner A invites an email address as **member**; verified B accepts in the app or CLI, selects the organization, and sees its channels. WorkOS owns invitation activation and organization membership. TOB checks current owner for send/list/revoke and checks B's current verified provider email before acceptance. Neither caller-supplied role nor invitation ID grants authority. Direct channel guests and Agent identities remain separate later slices.

## API and CLI

| HTTP | CLI | Access |
| --- | --- | --- |
| POST `/api/organizations/:org/invitations` | `invite send --server URL --email EMAIL --operation KEY` | Selected organization + current owner; body only email; fixed member, seven days |
| GET `/api/organizations/:org/invitations` | `invite list --server URL [--after ID]` | Current owner; managed invitations only |
| POST `/api/organizations/:org/invitations/:id/revoke` | `invite revoke --server URL --id ID` | Owner; revoking an accepted invitation does not remove membership |
| GET `/api/invitations` | `invite inbox --server URL [--after ID]` | Current verified recipient; no organization selection required |
| POST `/api/invitations/:id/accept` | `invite accept --server URL --id ID` | Current verified recipient; accepted_user_id and current membership read back |

After acceptance run `org use --server URL --id ORG_ID`, then `channel list`. An org-scoped token is still required for channel access; acceptance does not silently switch every client. Responses contain public invitation ID/status/email/org/expiry, never provider invitation token or acceptance URL. Email delivery itself is WorkOS's responsibility and is a separate acceptance gate from synthetic UAT API tests.

## Durable recovery and history

Org SQLite schema 4 adds `organization_invitation` (stable operation, inviter, email, provider ID, creation time) and `member_access_projection.history_from`. The journal is persisted before calling WorkOS. Same operation/different email conflicts. After an uncertain send, retries reconcile a single matching provider invitation for the exact org/recipient/inviter/role/time; they never blindly resend. Missing or ambiguous results return `OPERATION_RECONCILIATION_REQUIRED`. Do not replace the operation key to hide that state. Accepted/revoked requests read provider state first so lost acknowledgments can be retried.

A new active membership's history floor is its first confirmed TOB observation, persisted before channel access and kept through role changes and restarts. Acceptance records that observation. This is deliberately conservative when WorkOS created a pending membership earlier or a user accepted outside TOB: messages before first TOB confirmation are not exposed. New membership IDs reset the floor. Legacy projection rows migrate to the previous provider-created-at boundary; they are not re-granted older history. Each request uses the maximum of provider creation time and local floor. Deactivate/reactivate of the **same** membership ID between observations still needs the planned identity-event/rejoin gate; this slice does not close it.

No local transaction spans WorkOS and SQLite. External side effects may finish before a response is lost. Preserve records and provider resources on rollback; older workers must not be used to weaken the new history boundary after invitations are enabled. Forward repair is preferred. Public invitation listing is bounded at 50 and retains the provider cursor even if filtering yields an empty page.

## Verification status

Local: 36 workerd tests, 24 Node/CLI/contracts, typecheck and Forge build passed. Covers wrong recipient, owner/member boundary, revoked/expired/mismatched accepted identity, forged role, unknown provider invitation, lost send/accept response, eviction, concurrent retries, no blind resend, first-observation history and new membership ID.

Real UAT service `b6b717d044ff4a787de287c31d2029025bbbb7f9`, Worker version `2722f0bc-3ee0-4214-9917-116bcb9497bd`, schemas 4/4/1 passed formal CLI A→B send/replay, wrong-recipient denial, recipient inbox/accept replay, exact organization/channel agreement, hidden pre-join text, member create/invite/edit refusals and member text read by owner. Independent CLI selections were restored. Existing four-channel/seven-message history remains exact after migration. B now has its default workspace plus this joined workspace; no administrator binding changed. [Draft service PR #20](https://github.com/BotHarness/tob/pull/20) CI passed. Phone UI and actual email-delivery acceptance are pending for this slice. T1/T2 and the larger collaboration goal remain open. Prod and merges are out of scope.

Provider contract: [WorkOS invitation reference](https://workos.com/docs/reference/authkit/invitation). Its custom accept endpoint requires the application to check the intended recipient; this implementation uses the current verified provider user, not token email or request fields.
