# T1 first UAT increment

## Scope and evidence

This increment establishes the real Hono → D1 / SQLite Org DO path and an HTTP health CLI. It deliberately grants no business access. It is preparation within T1; it does not satisfy the mobile/CLI WorkOS login and organization acceptance path.

Local evidence: generated binding types and TypeScript pass, 4 workerd integration tests pass, 2 target-contract tests pass, 2 preparation-wizard tests pass, and cf build passes. A real local cf dev run returned health/ready successfully. Integration tests cover migration replay, DO eviction/persistence/isolation, and denial of spoofed identity. The Vitest plugin's experimental cf configuration requires a test-only self-binding override; the local dev run checks the actual production binding configuration separately.

Cloud preparation: the human-supplied CI token was verified active; the selected account, D1 and Worker inventory were read. A separate UAT D1 was provisioned and read back. GitHub Environment `uat` has only a `main` branch deployment policy, five public target variables, and `CLOUDFLARE_API_TOKEN`. This is a branch restriction, not a human-review gate. The token has account-level Worker/D1 permissions, not resource-level isolation; target checks are additional software safeguards. No production environment/resources/secrets were prepared.

### UAT runtime evidence — 2026-10-18 JST

Deployed source: `a5990f5b3925d05c0f4eb12b9aa0820e981a99e9` ([PR #7](https://github.com/BotHarness/tob/pull/7)). [First deployment](https://github.com/BotHarness/tob/actions/runs/39043544273/attempts/1) and [same-SHA repeat](https://github.com/BotHarness/tob/actions/runs/39043544273/attempts/2) both passed their check/deploy/smoke jobs. The repeated D1 migration command returned `[]` (nothing newly applied).

- Independent CLI readback returned the exact UAT release and instance with `ready=true`, D1 schema 1, Org schema 1 and `businessEnabled=false`.
- Both smoke runs confirmed organization creation returns `503 INSTANCE_NOT_INITIALIZED`.
- Cloudflare settings readback confirmed the intended D1 binding and SQLite Org namespace binding. SQL readback found one migration, zero administrators and zero instance policy rows; no business initialization occurred.
- These runs prove initial deployment and same-version replay. They do not prove forced interruption recovery, destructive rollback, WorkOS login, phone behavior or the completed T1 path. UAT remains on the source SHA above; subsequent documentation-only commits do not change the deployed code.

Health endpoint: [UAT health](https://tob-service-uat.yangmufeng233.workers.dev/healthz). This is a deployment probe, not a chat application.

## Human secret handoff

Run `python3 scripts/prepare-uat-ci-token.py` in your own terminal. It displays the token creation URL and accepts hidden input. It writes only a new 0600 `ci-secrets.env` in the existing 0700 `tob-staging` preparation profile. It neither validates permissions nor deploys. Never pass the token in arguments or chat. An existing file is preserved; rotation is a separate explicit operation.

An authorized deployment agent reads it locally, verifies the selected account and permissions without printing the value, and uses stdin for `gh secret set ... --env uat`. Personal Cloudflare OAuth credentials are never copied to CI. WorkOS API key and webhook secret are intentionally not uploaded yet: there is no authentication/event receiver in this increment.

## First resource preparation

The deployment agent checks the selected account and verifies that the UAT Worker/database names are unused before creation. After D1 creation, read back its UUID/name and record the public mapping outside Git. After a lost create response, query the existing name; do not create another database blindly. Read the account's workers.dev subdomain and form the UAT origin from that and the Worker name.

Set these **Environment** variables in `uat`: `CLOUDFLARE_ACCOUNT_ID`, `WORKER_NAME`, `INSTANCE_DB_ID`, `INSTANCE_ID`, `PUBLIC_BASE_URL`. Names in this increment are `tob-service-uat` and `tob-instance-uat`. Ordinary releases cannot provision an unresolved D1. The first Worker deployment creates its declared SQLite Org namespace; it does not create a business organization. The readiness probe uses one reserved, schema-only object.

## Release and retry

1. Run local tests/build and PR CI. Publish the reviewed commit to main.
2. Dispatch **Deploy UAT** from main with its exact 40-character commit SHA. The workflow verifies main ancestry and reruns checks without deployment secrets.
3. The deployment job uses only `uat`. It verifies account/D1 identity, builds, checks generated bindings/release identity, applies committed D1 migrations, then deploys the prebuilt Worker and its declared Org binding.
4. The smoke check requires the exact release/environment/instance, D1 and Org readiness, and `INSTANCE_NOT_INITIALIZED` for organization creation. A successful upload alone is insufficient.
5. Record the run URL, SHA and runtime results. No WorkOS configuration, invitation, administrator mutation or production action is part of this workflow.

Per-target deployment is serial and is not cancelled by later runs. A failed run can have applied D1 migrations or deployed the Worker: inspect its last completed phase and read back resources before retrying the **same SHA**. SQL migration tracking and the Org migration journal prevent duplicate application; a repeated successful UAT deployment is required evidence for retry. Migrations are initial additive tables with no business data yet. Worker rollback does not roll back data; destructive migration recovery and full interrupted-deploy qualification remain later gates.

## Pending T1 gates

WorkOS runtime secrets, configuration writes/readback, signed identity events, trusted configuration import, invitations and atomic administrator binding, phone PKCE, CLI device login, organization creation/reconciliation, refresh/revocation, and real-device Human QA are not implemented. Production release is explicitly rejected by the target resolver and has no workflow.
