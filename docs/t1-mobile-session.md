# T1 mobile session increment

This increment connects the DeepSeekBot development app to the existing UAT service without a local Host. It does not deliver organization operations or complete T1. Companion mobile issue: [DeepSeekBot#2101](https://github.com/BotHarness/DeepSeekBot/issues/2101).

## Public configuration and callback

The operator registers exactly `ai.botharness.deepseekbot.dev:/oauth2redirect` on the selected WorkOS Staging application, reads it back, and sets the same `MOBILE_REDIRECT_URI` in the GitHub **uat** environment and local public target record. Empty means mobile is disabled. Local mode ignores the variable; production remains rejected. WorkOS makes the first registered callback the default; this does not make invitation acceptance equivalent to application login.

After deploying the exact code SHA, re-read the authenticated Cloudflare settings and WorkOS environment/application callback. Export with:

```sh
node tools/deployment/export-uat-instance.mjs <private-profile> \
  --confirmed-workos-environment <environment_id> \
  --confirmed-mobile-redirect=ai.botharness.deepseekbot.dev:/oauth2redirect
node tools/deployment/render-instance-qr.mjs <private-profile>/tob-instance.json <new-output>.svg
```

The SVG contains the **entire strictly validated public JSON**, not a download URL or bearer token. Keep the operator's private directory private; show only the resulting QR. Rendering is offline and refuses to overwrite an existing output. Possession of this JSON is not authorization or proof that the operator verified the controls.

A phone selects Cloud services from pairing or the Host drawer, scans the QR, reviews the domain/instance/environment, and confirms trust. It checks discovery without credentials before saving. Changes to connection fields require explicit replacement and removal of the old local session; unchanged imports preserve it. Existing CLI imports need a verified replacement because the callback list is part of the connection identity. Other devices update independently; old remote sessions are not automatically revoked by configuration replacement.

## Native login and session authority

The phone creates random state and an S256 PKCE verifier, opens the system authentication browser, and accepts only the exact development callback and matching state in the live ten-minute transaction. Cancel/process death requires a new login. Cold callbacks are stripped from navigation and cannot create a session; codes/state are never router parameters. No embedded password form or client secret exists.

Tokens are exchanged only with the fixed WorkOS HTTPS token endpoint. Native `expo/fetch` rejects redirects. The phone stores rotating credentials in SecureStore and establishes instance access only through the service's signature-verified `/api/me`. Decoded JWT expiry is a refresh hint, not authorization. Session operations are serialized; rotated tokens are saved before follow-up readback. Transient refresh failures preserve credentials; `invalid_grant` clears them. There is no persistent offline admission cache.

Logout attempts remote revocation using the existing service endpoint and removes only that instance's local credentials even if the network/configuration has changed. The UI distinguishes remote-confirmed logout from local-only cleanup. A SecureStore write failure is an incomplete operation. Signing out of the phone must not sign out of the CLI.

## Acceptance and evidence boundaries

- [x] Source contract rejects foreign/duplicate callbacks, local inheritance and Prod deployment.
- [x] WorkOS Staging exact callback mutation and independent readback succeeded on 2026-10-18 JST; first callback is reported as default by WorkOS.
- [x] Local service checks: typecheck, 13 workerd tests and 18 Node tests pass.
- [x] Exact companion SHA `1ad3e6605a02965b3f9079f302ced02ca4a8f4c6` deployed to UAT; [workflow and smoke passed](https://github.com/BotHarness/tob/actions/runs/39053334521). Authenticated settings, OIDC and instance discovery matched; public configuration exported and offline QR generated.
- [ ] Development build installed; no-Host QR import, system-browser return, `/me`, refresh/rotation, cold restart and logout verified on a physical phone.
- [ ] Cancellation, offline/local-only logout, configuration replacement, secure-storage failure and default/intermediate/maximum text in light/dark verified on native surfaces where applicable.
- [ ] WorkOS session readback confirms phone session revoked and independent CLI session unchanged; Android separately qualified.

Source tests and a successful UAT deployment do not satisfy the unchecked native gates. T1 still needs organization creation/list/switch across phone and CLI, owner/member boundaries and creation retry, signed identity events/reconciliation and revocation propagation, failure recovery, and complete Human QA. No T2, Prod or mobile store release is authorized by this increment.

Mobile [Draft PR #2103](https://github.com/BotHarness/DeepSeekBot/pull/2103), head `a0b2919072af8fee62d8bb5fbb402fc52fb0d852`: full CI, mobile typecheck, 550 passing/8 skipped mobile tests, Expo Doctor 20/20 and both JS exports passed. Shared native window transferred to this task; phone build preparation in progress. No native/Human gate is marked passed. Documentation changes do not imply a new service deployment.
