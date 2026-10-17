import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('add_data_export_log migration (ADR-0103)', () => {
  const migrationsDir = join(__dirname, '../../../prisma/migrations');
  const dir = readdirSync(migrationsDir).find((d) =>
    d.endsWith('_add_data_export_log'),
  );
  const sql = dir
    ? readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    : '';
  const statements = sql
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n');

  it('exists', () => {
    expect(dir).toBeDefined();
  });

  it('only adds the new table: no other table altered, nothing dropped or rewritten', () => {
    expect(statements).toMatch(/CREATE TABLE "data_export_logs"/);
    expect(statements).not.toMatch(/^\s*(DROP|UPDATE|DELETE|TRUNCATE)\b/im);
    expect(statements).not.toMatch(/\bDROP\b/i);
    const altered = [...statements.matchAll(/ALTER TABLE "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(altered)).toEqual(new Set(['data_export_logs']));
  });

  it('allows at most one actor per row', () => {
    expect(statements).toMatch(
      /CONSTRAINT "data_export_logs_one_actor"\s+CHECK \(\(\("actorId" IS NOT NULL\)::int \+ \("serviceAccountId" IS NOT NULL\)::int\) <= 1\)/,
    );
  });
});
