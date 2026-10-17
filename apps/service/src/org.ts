import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../db/org/migrations/migrations";
import { orgConfig } from "../db/org/schema";

export class Org extends DurableObject<Env> {
  private readonly db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => { await migrate(this.db, migrations); });
  }
  // Internal binding RPC only. No public caller-selected DO IDs or mutation route.
  schemaStatus() {
    this.db.select({ orgId: orgConfig.orgId }).from(orgConfig).limit(1).all();
    return { schemaVersion: 1 };
  }
}
