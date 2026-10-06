import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Migrations not yet on the production database have to be safe to
 * apply under live customers AND leave the previous backend working
 * against the migrated schema -- because rolling back the code does not
 * roll back the database (Prisma has no down migrations).
 *
 * The previous backend reads and writes with Prisma, which names its
 * columns, so an extra nullable column is invisible to it. What breaks
 * it: a dropped or renamed column or table, a column it inserts without
 * that has become NOT NULL with no default, and a constraint that refuses
 * a write it makes. The last one is not hypothetical: the per-device
 * foreign key was first written ON DELETE RESTRICT, and a rollback would
 * have failed sign-in for every customer whose signed-out session still
 * held credentials, because the old code prunes those sessions on every
 * sign-in.
 *
 * LAST_DEPLOYED is the newest migration known to be applied in
 * production (CLAUDE.md, "Versions and tags"). Move it forward when a
 * deploy lands; everything after it is checked here. */
const LAST_DEPLOYED = "20261006_customer_sessions";

const MIGRATIONS_DIR = join(__dirname, "..", "prisma", "migrations");

function pending(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name > LAST_DEPLOYED)
    .map((d) => ({
      name: d.name,
      // Comments stripped, so prose explaining what is NOT done cannot
      // trip the checks below.
      sql: readFileSync(join(MIGRATIONS_DIR, d.name, "migration.sql"), "utf8")
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n"),
    }));
}

describe("pending migrations are additive and rollback-safe", () => {
  const migrations = pending();

  it("finds the migrations this branch adds", () => {
    expect(migrations.map((m) => m.name)).toEqual(expect.arrayContaining(["20261007_per_device_credentials"]));
  });

  it.each(migrations.map((m) => [m.name, m.sql]))("%s drops, renames and tightens nothing", (_name, sql) => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b.*\bTYPE\b/i);
  });

  it.each(migrations.map((m) => [m.name, m.sql]))("%s adds only columns the old code can ignore", (_name, sql) => {
    for (const statement of sql.split(";")) {
      for (const match of statement.matchAll(/ADD COLUMN\s+"[^"]+"\s+([^,]*)/gi)) {
        const definition = match[1];
        // NOT NULL is fine only with a default: the old backend's inserts
        // do not name the column.
        if (/NOT NULL/i.test(definition)) expect(definition).toMatch(/DEFAULT/i);
      }
    }
  });

  // The old backend deletes signed-out and idle sessions on every sign-in
  // without knowing devices hold credentials; RESTRICT turned that into a
  // 500 on sign-in, CASCADE would drop live credentials without telling
  // the node.
  it("lets a session row be deleted under the old backend without losing its credentials", () => {
    const all = migrations.map((m) => m.sql).join("\n");
    const fk = all.match(/CONSTRAINT "protocol_users_sessionId_fkey"[^;]*/i)?.[0] ?? "";
    expect(fk).toMatch(/ON DELETE SET NULL/i);
  });
});
