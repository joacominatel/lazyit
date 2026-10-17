import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPDATE_RUN_ACTIVE_STATUSES,
  UPDATE_RUN_STATUSES,
} from '@lazyit/shared';

describe('add_update_runs_single_active_index migration (AUD-061)', () => {
  const migrationsDir = join(__dirname, '../../prisma/migrations');
  const dir = readdirSync(migrationsDir).find((d) =>
    d.endsWith('_add_update_runs_single_active_index'),
  );
  const sql = dir
    ? readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    : '';

  const terminal = UPDATE_RUN_STATUSES.filter(
    (s) => !(UPDATE_RUN_ACTIVE_STATUSES as readonly string[]).includes(s),
  );

  it('exists', () => {
    expect(dir).toBeDefined();
  });

  // A terminal status added to the shared catalog but not here would count as active and block every enqueue.
  it('keys "active" on exactly the shared terminal set, in both the dedupe and the index', () => {
    const predicates = [...sql.matchAll(/"status" NOT IN \(([^)]*)\)/g)].map(
      (m) =>
        m[1]
          .split(',')
          .map((s) => s.trim().replace(/'/g, ''))
          .sort(),
    );
    expect(predicates).toHaveLength(2);
    for (const p of predicates) expect(p).toEqual([...terminal].sort());
  });

  it('resolves existing duplicates before building the index, without deleting rows', () => {
    expect(sql).not.toMatch(/\bDELETE\b/i);
    const update = sql.search(/UPDATE "update_runs"/);
    const index = sql.search(
      /CREATE UNIQUE INDEX "update_runs_single_active_key"/,
    );
    expect(update).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(update);
  });
});
