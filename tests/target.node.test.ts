import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../tools/deployment/target.ts";
const publicFixture = { PUBLIC_BASE_URL: "https://example.test", WORKOS_AUTH_DOMAIN: "fixture.authkit.app", WORKOS_CLIENT_ID: "client_fixture", WORKOS_ENVIRONMENT_ID: "environment_fixture", WORKOS_ISSUER: "https://api.workos.com/user_management/client_fixture", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), WORKER_NAME: "tob-service-uat", INSTANCE_DB_ID: "00000000-0000-4000-8000-000000000002", INSTANCE_ID: "tob-instance-uat", RELEASE_SHA: "b".repeat(40) };
test("local ignores inherited remote configuration", () => {
  assert.equal(resolveTarget("development", publicFixture).environment, "local");
  assert.equal(resolveTarget("development", publicFixture).accountId, undefined);
});
test("UAT requires every target field and rejects production before cloud I/O", () => {
  assert.equal(resolveTarget("uat", publicFixture).workerName, "tob-service-uat");
  for (const key of Object.keys(publicFixture)) {
    assert.throws(() => resolveTarget("uat", { ...publicFixture, [key]: undefined }), /INVALID_DEPLOYMENT_CONFIG/);
  }
  assert.throws(() => resolveTarget("production", publicFixture), /UNSUPPORTED/);
  assert.throws(() => resolveTarget("uat", { ...publicFixture, WORKER_NAME: "production" }), /INVALID/);
});

test("UAT issuer must belong to the configured application", () => {
  for (const issuer of ["https://api.workos.com/", "https://api.workos.com/user_management/client_other"]) {
    assert.throws(() => resolveTarget("uat", { ...publicFixture, WORKOS_ISSUER: issuer }), /INVALID_DEPLOYMENT_CONFIG:WORKOS_ISSUER/);
  }
});
