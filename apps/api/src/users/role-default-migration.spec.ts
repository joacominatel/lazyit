import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR-0043 — the DEFAULT VIEWER flip must NOT retroactively change existing rows (CEO decision #6:
 * existing users keep their role; only NEW inserts get the VIEWER default). In Postgres a
 * `ALTER COLUMN ... SET DEFAULT` is metadata-only and never rewrites existing rows, whereas a
 * data-touching `UPDATE` would backfill them. This guards the migration's SHAPE so a future edit
 * can't silently turn it into a backfill.
 */
describe('change_role_default_viewer migration (ADR-0043)', () => {
  const migrationsDir = join(__dirname, '../../prisma/migrations');

  function readMigration(suffix: string): string {
    const dir = readdirSync(migrationsDir).find((d) => d.endsWith(suffix));
    if (!dir) {
      throw new Error(`Migration ending in "${suffix}" not found`);
    }
    return readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8');
  }

  it("sets the role column default to 'VIEWER'", () => {
    const sql = readMigration('change_role_default_viewer');
    expect(sql).toMatch(/ALTER COLUMN "role" SET DEFAULT 'VIEWER'/i);
  });

  it('only alters the default — never backfills existing rows (no UPDATE)', () => {
    const sql = readMigration('change_role_default_viewer');
    // A backfill would be `UPDATE "users" SET "role" = ...`; the SET DEFAULT must stand alone.
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });
});
