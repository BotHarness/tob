import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./apps/service/db/channel/schema.ts", out: "./apps/service/db/channel/migrations", driver: "durable-sqlite" });
