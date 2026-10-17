/** Single target resolver used by cf and deployment tooling. No cloud I/O. */
export function resolveTarget(mode: string | undefined, env: NodeJS.ProcessEnv) {
  if (!mode || mode === "development" || mode === "test") {
    return { environment: "local", workerName: "tob-local", databaseId: "00000000-0000-4000-8000-000000000001", instanceId: "tob-local", releaseSha: "local", accountId: undefined, workosClientId: "client_local", workosEnvironmentId: "environment_local", workosIssuer: "https://api.workos.com/user_management/client_local", publicBaseUrl: "https://example.test", authkitDomain: "local.authkit.app" };
  }
  // Production is deliberately not deployable in this T1 increment.
  if (mode !== "uat") throw new Error("UNSUPPORTED_DEPLOYMENT_TARGET");
  function required(name: string, pattern: RegExp) {
    const value = env[name];
    if (!value || !pattern.test(value)) throw new Error(`INVALID_DEPLOYMENT_CONFIG:${name}`);
    return value;
  }
  const workosClientId = required("WORKOS_CLIENT_ID", /^client_[A-Za-z0-9]+$/);
  const workosIssuer = required("WORKOS_ISSUER", /^https:\/\/api\.workos\.com\/user_management\/client_[A-Za-z0-9]+$/);
  if (workosIssuer !== `https://api.workos.com/user_management/${workosClientId}`) throw new Error("INVALID_DEPLOYMENT_CONFIG:WORKOS_ISSUER");
  return {
    environment: "uat",
    publicBaseUrl: required("PUBLIC_BASE_URL", /^https:\/\/[a-z0-9.-]+$/),
    authkitDomain: required("WORKOS_AUTH_DOMAIN", /^[a-z0-9]+(?:-[a-z0-9]+)*\.authkit\.app$/),
    workosClientId,
    workosEnvironmentId: required("WORKOS_ENVIRONMENT_ID", /^environment_[A-Za-z0-9]+$/),
    workosIssuer,
    accountId: required("CLOUDFLARE_ACCOUNT_ID", /^[a-f0-9]{32}$/),
    workerName: required("WORKER_NAME", /^tob-[a-z0-9-]+-uat$/),
    databaseId: required("INSTANCE_DB_ID", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    instanceId: required("INSTANCE_ID", /^tob-[a-z0-9-]+-uat$/),
    releaseSha: required("RELEASE_SHA", /^[a-f0-9]{40}$/),
  };
}
