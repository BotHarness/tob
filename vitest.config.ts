import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    experimental: { newConfig: true }, remoteBindings: false,
    // Vitest renames the Worker. Keep the same class, but bind it to the test isolate.
    miniflare: { durableObjects: { ORGS: { className: "Org", useSQLite: true }, CHANNELS: { className: "Channel", useSQLite: true } }, bindings: { WORKOS_API_KEY: "local-test-secret", TEST_MIGRATIONS: await readD1Migrations("./apps/service/db/d1/migrations") } },
  })],
  test: { include: ["tests/service.test.ts"], fileParallelism: false },
}));
