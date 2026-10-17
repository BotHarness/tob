import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./apps/service/src/index.ts" with { type: "cf-worker" };
import { resolveTarget } from "./tools/deployment/target.ts";

export default defineConfig(({ mode }) => {
  const target = resolveTarget(mode, process.env);
  const owner = { name: target.workerName, entrypoint, compatibilityDate: "2026-10-17", exports: { Org: exports.durableObject({ storage: "sqlite" }) } };
  return {
    accountId: target.accountId,
    worker: {
      name: target.workerName,
      entrypoint,
      compatibilityDate: "2026-10-17",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: true,
      previewUrls: false,
      observability: {
        enabled: true, redactQueryString: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
      exports: { Org: exports.durableObject({ storage: "sqlite" }) },
      env: {
        INSTANCE_DB: bindings.d1({ id: target.databaseId }),
        ORGS: bindings.durableObject({ worker: owner, exportName: "Org" }),
        WORKOS_API_KEY: target.environment === "local" ? bindings.json("local-test-secret") : bindings.secret(),
        PUBLIC_BASE_URL: bindings.json(target.publicBaseUrl),
        WORKOS_AUTH_DOMAIN: bindings.json(target.authkitDomain),
        WORKOS_CLIENT_ID: bindings.json(target.workosClientId),
        WORKOS_ISSUER: bindings.json(target.workosIssuer),
        WORKOS_ENVIRONMENT_ID: bindings.json(target.workosEnvironmentId),
        INSTANCE_ID: bindings.json(target.instanceId),
        DEPLOYMENT_ENV: bindings.json(target.environment),
        RELEASE_SHA: bindings.json(target.releaseSha),
      },
    },
  };
});
