import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { eq, and } from "drizzle-orm";
import migrations from "../db/org/migrations/migrations";
import { orgConfig, memberAccessProjection } from "../db/org/schema";
type VerifiedMember = { id: string; user_id: string; organization_id: string; status: string; role: { slug: string } };
export class Org extends DurableObject<Env> {
  private readonly db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => { await migrate(this.db, migrations); });
  }
  schemaStatus() { this.db.select().from(orgConfig).limit(1).all(); return { schemaVersion: 2 }; }
  initialize(orgId: string, name: string) {
    const old = this.db.select().from(orgConfig).get();
    if (old && (old.orgId !== orgId || old.status !== "active")) throw new Error("ORG_STATE_CONFLICT");
    this.db.insert(orgConfig).values({ orgId, name, status: "active", policyJson: "{}", version: 1 }).onConflictDoNothing().run();
  }
  // Internal binding RPC only. The Worker checks current WorkOS membership, never caller role headers.
  read(orgId: string) {
    const row = this.db.select().from(orgConfig).where(and(eq(orgConfig.orgId, orgId), eq(orgConfig.status, "active"))).get();
    if (!row) throw new Error("ORG_NOT_ACTIVE");
    return { organizationId: row.orgId, name: row.name, description: row.description, version: row.version };
  }
  private observe(orgId: string, member: VerifiedMember) {
    if (member.organization_id !== orgId || member.status !== "active" || !["owner", "member"].includes(member.role.slug)) throw new Error("INVALID_MEMBER");
    const row = { workosUserId: member.user_id, membershipId: member.id, status: member.status, role: member.role.slug, verifiedAt: new Date().toISOString() };
    this.db.insert(memberAccessProjection).values(row).onConflictDoUpdate({ target: memberAccessProjection.workosUserId, set: row }).run();
  }
  view(orgId: string, member: VerifiedMember) { const result = this.read(orgId); this.observe(orgId, member); return result; }
  update(orgId: string, member: VerifiedMember, description: string, version: number) {
    if (member.role.slug !== "owner") throw new Error("OWNER_REQUIRED");
    this.read(orgId); this.observe(orgId, member);
    const rows = this.db.update(orgConfig).set({ description, version: version + 1 }).where(and(eq(orgConfig.orgId, orgId), eq(orgConfig.status, "active"), eq(orgConfig.version, version))).returning().all();
    return rows.length ? this.read(orgId) : null;
  }
}
