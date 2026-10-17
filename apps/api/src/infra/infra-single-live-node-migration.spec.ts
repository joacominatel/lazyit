import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('infra_single_live_node_per_asset migration', () => {
  const migrationsDir = join(__dirname, '../../prisma/migrations');
  const dir = readdirSync(migrationsDir).find((d) =>
    d.endsWith('_infra_single_live_node_per_asset'),
  );
  const sql = dir
    ? readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    : '';

  it('exists', () => {
    expect(dir).toBeDefined();
  });

  it('keeps the latest reporter (never-reported last, then the oldest), un-links the rest, and deletes nothing', () => {
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).toMatch(
      /PARTITION BY "assetId"\s+ORDER BY "lastReportedAt" DESC NULLS LAST, "createdAt" ASC, "id" ASC\)/,
    );
    expect(sql).toMatch(/SET "assetId" = NULL,\s+"specs" = CASE/);
    expect(sql).toMatch(/ranked\.rn > 1/);
  });

  it('stamps each dropped link on the node it was taken from', () => {
    expect(sql).toMatch(
      /'_infraAssetUnlinked',\s+jsonb_build_object\(\s+'assetId', n\."assetId",\s+'keptByNodeId', ranked\."keptNodeId"/,
    );
    // A non-object blob is kept as it is rather than replaced.
    expect(sql).toMatch(/ELSE n\."specs"/);
  });

  it('resolves existing shared links before building the live-only index', () => {
    const update = sql.search(/UPDATE "infra_nodes"/);
    const index = sql.search(
      /CREATE UNIQUE INDEX "infra_nodes_assetId_active_key"\s+ON "infra_nodes" \("assetId"\)\s+WHERE "deletedAt" IS NULL\s+AND "assetId" IS NOT NULL;/,
    );
    expect(update).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(update);
  });
});
