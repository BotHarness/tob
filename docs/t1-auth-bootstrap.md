# T1: real WorkOS login and first administrator

This UAT-only increment connects a real WorkOS Human session to TOB's durable instance admission. It does not implement phone UI, product CLI sessions, organization creation or group messaging. `/api/me` is the sole authenticated capability (`instance:read-self`); other business commands remain closed. Production is rejected by the target resolver.

## Login and authority

The deployer verifies the WorkOS project, sandbox environment, application/client ID and hosted domain through the authenticated control plane. Public UAT variables are `WORKOS_CLIENT_ID`, `WORKOS_ENVIRONMENT_ID` and `WORKOS_ISSUER`. This increment supports the client-specific `https://api.workos.com/user_management/{clientId}` issuer; custom issuers remain unsupported. Deployment preflight reads the fixed client’s official OIDC discovery document and compares its issuer and JWKS URL before cloud mutations. Source code contains no account-specific identifiers.

The Worker verifies RS256 tokens against the fixed client's HTTPS JWKS, validates issuer, expiration, required user/session claims and any supplied audience/authorized party. Request headers and JWT fields cannot choose keys or issuer. The JWT proves identity only: a matching active administrator, fixed admin-only policies and the succeeded first-initialization receipt must also exist in D1. Anonymous/invalid identity receives 401, an uninitialized instance receives 503, an unauthorized Human receives 403. No email, organization role or caller-supplied user ID grants authority.

D1 administrator revocation is checked on every request. WorkOS session revocation is currently bounded by signed access-token expiry (the verified application currently uses 300 seconds); there is no claim of immediate WorkOS revocation. Signed identity events, refresh/logout product behavior and a measured end-to-end revocation window remain full T1 gates. JWKS lookup currently happens per request; this small validation slice is not a throughput qualification.

## Invite and initialize

1. Close public WorkOS signup and read it back. Query existing application users/invitations before sending. Send an application-only invitation to the explicitly selected email; no organization/role assignment. Reuse an accepted user or pending invitation and never blindly resend after an unknown outcome.
2. The Human follows the email link and authenticates, including Google when enabled. Without an app callback configured, AuthKit may show its successful-login/setup page. This proves neither TOB admission nor mobile callback completion.
3. Read the invitation's actual `accepted_user_id`; read that user and compare the selected email and `email_verified=true`. Immediately before binding, independently check the user's active/not-banned status through WorkOS MCP. The public GET-user response does not expose this status: do not infer `false` from a missing field.
4. Run the protected tool with the checked user ID:

   ```bash
   node tools/bootstrap/initialize-uat.mjs /absolute/private/profile --confirmed-active-user user_EXAMPLE
   ```

   The explicit confirmation records the operator's fresh MCP eligibility check; it is not an authorization credential. The tool requires private Cloudflare and WorkOS credentials, verifies the accepted user again, and reads the actual UAT Worker bindings, D1 ID/name and origin before writing. It refuses mismatches. There is no public bootstrap HTTP endpoint, shared initialization password or new bootstrap token.
5. One SQL statement inserts the fixed `instance.initialize` management receipt only if absent. A SQLite trigger checks empty/inconsistent state and atomically inserts both the administrator and fixed policy. Receipt, administrator and policy either all commit or all roll back. The receipt payload hash binds account, database, instance, WorkOS environment/client and actual user. The exact same production SQL is exercised in workerd tests.
6. After any response loss, rerun and read the fixed receipt plus administrator/policy. Same target and active status succeed without changing original grant metadata; different targets, missing/inconsistent rows and inactive/revoked grants fail. No retry restores a revoked administrator. Provider failures produce bounded phase codes without exception dumps or secrets.

The deployment operator still has Cloudflare control-plane authority; local confirmation flags and target records do not constrain an account administrator who bypasses the tool. The tool provides a reproducible safe path, not a replacement for provider permissions.

## Real-login verification harness

The machine-local, operator-verified `uat-target.json` is extended with the public WorkOS fields above and `WORKOS_AUTH_DOMAIN`. `bootstrap-target.json` contains the selected email, environment/client and invitation ID, never an invitation token/link. Both live outside Git with mode 0600 in a 0700 profile.

```bash
node tools/auth/verify-login.mjs /absolute/private/profile login
# Human opens the displayed WorkOS URI and confirms the displayed user code.
node tools/auth/verify-login.mjs /absolute/private/profile me
```

This verification harness uses the official public-client device grant, not a second authentication protocol. It prints only the verification URI/user code and sanitized status. The device code stays in process memory. Tokens are stored in a new 0600 `uat-login-session.json` outside Git, bound to the fixed instance/client; an old session is not silently overwritten. Every use verifies the token before it is sent to TOB; failed verification preserves the private file for diagnosis/revocation and never grants access. It does not refresh, open the browser or implement the eventual CLI session store. An operator may use the official public-client refresh grant for evidence collection, atomically replacing the private tokens after full verification; this is not yet a product CLI capability. Otherwise expired sessions require a deliberate new verification login. Revoke the test session and remove the local file after evidence collection.

For this slice, run login before initialization to observe a valid identity rejected by `/api/me`, initialize, then run `me` with that same session to observe admission. Repeat initialization and compare grants/receipt. These private runtime records must not be uploaded as CI artifacts. No server API key is needed in the Worker for signature validation; the WorkOS key remains only in the protected deployment process. Runtime secrets and signed events follow when they have real consumers.

## Evidence and remaining boundaries

Local tests cover JWT signature/issuer/audience/expiry, unknown Human and provider failure, missing policy, immediate D1 revocation, actual invitation/verified-email mismatch, competing first administrators, response-loss replay, inactive grants and rollback after a policy insert. CI and live UAT evidence are recorded after running, separately from these source tests.

Trusted configuration import/QR, mobile PKCE callbacks, product CLI login/refresh/logout, organizations/roles/reconciliation, signed events and native Human QA remain pending. The initial invitation may use the configured Google provider in WorkOS Staging; that does not qualify production OAuth credentials.

References: [WorkOS device flow](https://workos.com/docs/authkit/cli-auth), [invite-only signup](https://workos.com/docs/authkit/invite-only-signup), [invitations and accepted identity](https://workos.com/docs/authkit/invitations), [session claims](https://workos.com/docs/authkit/sessions), [client-specific issuer](https://workos.com/docs/cli/emulate), [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
