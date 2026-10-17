import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./apps/service/db/org/schema.ts", out: "./apps/service/db/org/migrations", driver: "durable-sqlite" });
