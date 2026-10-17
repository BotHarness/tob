import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./apps/service/db/d1/schema.ts", out: "./apps/service/db/d1/migrations" });
