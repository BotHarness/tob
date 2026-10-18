# T1: trusted instance import and CLI sessions

This increment follows the verified UAT administrator path. It implements file import, device login, identity readback, refresh and own-session logout through `apps/cli/tob.mjs`. It does not implement phone import/QR/native callbacks, organizations, group messaging or production deployment. Source tests and CI are separate from the live UAT acceptance below.

## Deployer handoff

The deployment agent first reads the authenticated WorkOS control plane: the selected environment is Staging, its client/application and hosted domain match the private target, signup is disabled and no unregistered mobile callbacks are advertised. WorkOS key provenance remains the previous usage-record correlation, not direct key introspection.

The private `uat-target.json` additionally supplies `PUBLIC_BASE_URL` and `WORKOS_AUTH_DOMAIN`. UAT GitHub variables carry these public values. The Worker requires a `WORKOS_API_KEY` secret for own-session revocation; CLI users never receive it. With the existing private profile:

```bash
node tools/deployment/install-uat-auth-secret.mjs /absolute/private/profile
```

The tool validates existing Worker/D1/client/environment bindings and the accepted invitation through the stored WorkOS key. It passes the value to `cf workers secrets bulk` over stdin and reads back secret metadata only. A failed result is unconfirmed: read provider state before retry. Secret metadata does not prove its value or runtime permissions. Deploying the exact main SHA then verifies discovery, health, schema readiness and anonymous refusal. No webhook secret is needed in this increment. Later deploys preserve the secret binding; public discovery never includes it.

After deployment and a fresh WorkOS MCP check:

```bash
node tools/deployment/export-uat-instance.mjs /absolute/private/profile --confirmed-workos-environment environment_EXAMPLE
```

This flag records the deployment operator's WorkOS control-plane check, not cryptographic evidence for the client. The exporter independently reads Cloudflare bindings/origin, fixed WorkOS OIDC discovery and the public service discovery, compares them, and atomically writes `tob-instance.json` inside the private profile. Only explicit public connection fields are serialized. No admin identity, API key, token, Cloudflare account/D1 ID or WorkOS environment ID is exported.

The caller must obtain this file from their trusted deployment operator. Anyone can write a matching file and discovery response; consistency is not proof of service ownership. Reverify the two provider control planes after changes before exporting again.

## User path

Run from the repository with its pinned Node/toolchain (`pnpm tob` is a convenience wrapper). Use the direct Node entrypoint when a single JSON stdout document is needed:

```bash
node apps/cli/tob.mjs instance import /absolute/path/tob-instance.json
node apps/cli/tob.mjs login --server https://groups.example.com
node apps/cli/tob.mjs whoami --server https://groups.example.com
node apps/cli/tob.mjs refresh --server https://groups.example.com
node apps/cli/tob.mjs logout --server https://groups.example.com
```

`login` prints the instance, environment, WorkOS URL and human confirmation code to stderr. The human opens the URL and approves; the CLI does not automatically launch a browser or print the private device code. Ordinary stdout contains one structured result or coded error, never tokens. Ctrl-C cancels polling. Polls respect expiry, interval and `slow_down`.

Only imported HTTPS instances are usable. Before login, refresh and bearer requests, unauthenticated discovery must match the pinned connection. Redirects are refused. Discovery cannot change endpoints. The supported provider is standard WorkOS with a client-specific issuer and hosted `authkit.app` domain; generic/custom OIDC and mobile callback lists are not accepted yet. `mobileRedirectUris: []` explicitly advertises no mobile login capability.

Same-config reimport is idempotent. Display-name-only edits preserve the session. Critical replacement first shows previous/next public configuration and fails with `CONFIG_REPLACEMENT_REQUIRED`; after deployment re-verification, repeat with `--replace`. Successful replacement clears that instance's local credentials before storing the new configuration. Failed verification preserves old state but does not permit bypassing mismatched discovery. Another instance ID does not overwrite an existing ID or migrate its session. A duplicate server assigned to a different ID is rejected.

## Storage and interruption

The POSIX CLI store defaults to `~/.config/tob/cli`; `TOB_CONFIG_DIR` selects a separate absolute, non-symlink directory for tests or automation. This implementation is qualified for macOS/Linux file permissions; Windows credential storage is not delivered. Directories are owner-only 0700; instance files and credentials are separate 0600 files. This is OS permission protection, not application-level encryption or Keychain storage.

One current session per imported instance is bound to the whole connection configuration and verified user ID. Login will not silently overwrite an existing session. Every use performs signature/claims verification, and TOB independently checks current administrator admission. A received/rotated token pair is atomically persisted before verification/network readback so a temporary verification failure cannot lose rotated credentials; possession of a stored file never skips verification or confers admission.

Per-instance process locks prevent concurrent login/refresh/logout/config replacement. A second live operation returns `SESSION_BUSY`; retry after it finishes. A dead owner's lock can be recovered on the next attempt. An interrupted lock with incomplete metadata is refused; an operator must confirm no CLI process remains before removing that exact lock file. Atomic write/rename plus fsync protects normal interruption; power-loss durability and every filesystem are not qualified.

`whoami` refreshes an expired access token automatically. Explicit `refresh` uses the public-client WorkOS grant and atomically replaces rotated tokens. A definitive HTTP 400 `invalid_grant` clears the session and requires login. Network errors, 429 and 5xx preserve credentials with coded retry status; callers back off before retry. A lost refresh response can become unrecoverable after the provider's grace period, requiring a new login; no exactly-once refresh claim is made.

## Logout boundary

The Worker verifies the caller's token and takes `sid` only from its signed claims. It ignores caller-supplied user/session IDs and sends a server-authenticated revocation request to WorkOS. This self-cleanup route does not require business admission, so a user denied business access can still end their own valid session. It does not grant access to groups or organizations.

The CLI always clears its local credentials on logout, including expired-login, offline and discovery-mismatch paths. Successful provider response yields `remoteRevoked: true`; otherwise it returns `REMOTE_LOGOUT_UNCONFIRMED`, and may require operator/provider cleanup. It does not send a token to a changed destination or revoke other devices. Repeated local logout is idempotent. Existing signed access tokens can remain usable until expiry; immediate server-wide invalidation and signed identity events remain later T1 gates.

## Acceptance and evidence

- Local coverage: real RSA signature verification, private-file import/login/refresh/logout, unknown/mismatched configuration without credential transmission, explicit replacement, name-only reimport, refresh failure/invalid_grant, concurrent refresh refusal, expired-token refresh, polling/backoff/denial/cancellation, private permissions and symlink refusal.
- Worker coverage: fixed public discovery, anonymous logout refusal, signed own-session selection despite a spoofed request body, provider failure, and previous administrator/bootstrap tests.
- Live UAT: verified on 2026-10-18 JST; details and exact deployed source below. This qualifies the CLI increment only, not the phone/organization T1 path.
- Phone/QR/native callbacks, organizations, multi-device Human QA, measured revocation propagation and Production remain outside this increment.

References: [WorkOS device login and public refresh](https://workos.com/docs/authkit/cli-auth), [refresh resilience](https://workos.com/docs/authkit/session-resilience), [session revocation](https://workos.com/docs/reference/authkit/session).

## Live UAT evidence — 2026-10-18 JST

Implementation [PR #11](https://github.com/BotHarness/tob/pull/11), bounded diagnostics [PR #12](https://github.com/BotHarness/tob/pull/12), and runtime fix [PR #13](https://github.com/BotHarness/tob/pull/13) are merged. Exact source deployed and verified: `5c178595c5adf4c4eab65df4dd9fcfb56cd06fbc`; [UAT checks, deployment and smoke](https://github.com/BotHarness/tob/actions/runs/39051521846) succeeded. Later documentation changes do not imply another deployment.

| Path | Observed result |
| --- | --- |
| Trusted handoff | Authenticated provider control-plane checks, independently compared deployment/public discovery, public-file export and actual CLI import passed. Configuration remained unchanged across the fix deployment. |
| Human device authorization | The Human approved the product CLI device request; signed identity and UAT administrator readback passed. Expired requests failed closed and were replaced explicitly. |
| Product CLI identity and refresh | `whoami` returned the initialized administrator; `refresh` rotated the refresh token while preserving the verified user and session. |
| Product CLI logout | `localLoggedOut: true`, `remoteRevoked: true`; independent WorkOS readback confirmed only this session disappeared. Other listed sessions were unchanged. |
| After logout | Local credentials absent; `whoami` returned `NOT_LOGGED_IN`; the revoked refresh token returned HTTP 400 `invalid_grant`; repeated logout was idempotent. |
| Cleanup | The diagnostic token copy was removed after revocation; the actual CLI credential store has no session. Log streaming ended. No secrets or private identity values are published. |

The first runtime logout failed with HTTP 503. UAT diagnostics narrowed it to `provider_transport/TypeError`; native request construction in the pinned workerd reproduced rejection of `redirect: "error"`. The earlier network mock did not construct a native Request, so it missed this runtime incompatibility. The fix uses `manual` and refuses non-2xx responses, including all redirects, without forwarding the server key. Handler regression coverage now includes native Request validation and a refused 302 destination. Node CLI requests retain their supported redirect-error behavior.

The successful final replay used the same Human-approved session, restored from a private diagnostic copy after prior failed logout had correctly removed the normal local file. Every reuse validated the pinned configuration and signed identity; it did not create another identity or bypass authentication. The final pass drove the actual product CLI and independently queried WorkOS. The copy is now deleted.

Checks for this source: typecheck/build, 13 workerd tests, 16 Node tests, plus 2 wizard tests in CI. Live configuration-drift, crash/power-loss, cross-device and native-mobile scenarios were not run; their source tests/design must not be described as cloud or Human QA evidence. WorkOS access JWTs may remain valid until expiry after revocation; immediate access-token invalidation remains a later T1 gate.

Remaining T1 work: mobile QR/import and native PKCE/secure storage, independent phone/CLI organization access, owner/member setup and organization creation/retry, signed identity-event reconciliation and measured revocation behavior, and native Human QA. T1 stays open; T2–T5 and Production are untouched.

## Recipient-bound invitation links (next tracer, validation in progress)

An invitation locator has the form `https://<instance>/join?invitation=<invitation-id>`. It contains no WorkOS token or Agent credential and does not grant access. The public landing only displays the service and opens the native client. Destination metadata requires a verified invited account through `GET /api/invitations/:id` or `GET /api/channel-invitations/:id`; neither GET accepts the invitation. Existing POST acceptance and revocation remain authoritative.

```sh
node apps/cli/tob.mjs invitation-link https://groups.example ci_<id>
node apps/cli/tob.mjs channel-invite preview --server https://groups.example --link 'https://groups.example/join?invitation=ci_<id>'
node apps/cli/tob.mjs channel-invite accept --server https://groups.example --link 'https://groups.example/join?invitation=ci_<id>'
```

Use `invite` instead of `channel-invite` for workspace invitations. The explicit server must match the link and an independently imported configuration; link parsing never imports trust or logs into another server. A wrong account gets no destination metadata. A revoked or expired invitation cannot be accepted. Mobile adds a device-local pending target through login/restart, then explicitly accepts and opens the selected guest channel without obtaining workspace membership.

Local validation: 62 workerd tests and 20 CLI tests passed, including recipient preview/no-join, wrong-account denial, revoked acceptance denial, neutral landing and cross-server credential refusal. This records source/local runtime evidence only. UAT deployment, real invitation replay and native screenshots/recording for this new slice remain pending; no Prod change or merge is implied. QR display/save and the unified cloud workspace drawer are follow-up work.

### UAT API/CLI replay — 2026-10-18

Service `f10437bfbe46c4cbcbfb71bc6b599e9551669051` passed [CI](https://github.com/BotHarness/tob/actions/runs/39100874671), was deployed through the existing guarded UAT-only helper, and read back the same version with D1/Org/Channel schemas 5/4/5. [Sanitized replay evidence](evidence/invitation-journey-uat.json) records actual synthetic A/B accounts: recipient preview without joining, wrong-account/anonymous refusal, neutral landing without destination data, explicit server mismatch refusal, revoked acceptance denial, no workspace membership and sibling-channel refusal. A separate pending invitation was retained for native acceptance; it does not prove phone acceptance yet.

- [x] Public locator and recipient preview through real UAT CLI/API.
- [x] Wrong-account, no-join, revoked and cross-server boundaries.
- [ ] Assigned native before/after evidence: copy/share, import, login/restart target retention, accept and exact-channel navigation.
- [ ] QR rendering/save and real camera acceptance, followed by separate platform coverage.
