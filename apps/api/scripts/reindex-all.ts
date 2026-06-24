/**
 * Reindex every Meilisearch index from the database (ADR-0035). Run on first deploy and to repair
 * drift after Meili downtime. Standalone bun script — NOT wired into Nest — so it carries its own
 * PrismaClient (Postgres adapter + DATABASE_URL) and Meilisearch client.
 *
 * Because it bypasses the Nest soft-delete extension (ADR-0032), every fetch filters `deletedAt:
 * null` explicitly; articles are additionally restricted to PUBLISHED to honor draft privacy
 * (ADR-0022) — soft-deleted/draft rows must never end up in the index.
 *
 * AUTHORITATIVE REBUILD: each index is rebuilt via {@link reindexIndex} (build a fresh temp index
 * from the live set, then atomically swap it into place). Unlike the previous additive-only
 * `addDocuments`, this **evicts ghost documents** — soft-deleted USER PII or unpublished/deleted
 * articles whose fire-and-forget `remove()` was dropped — instead of leaving them searchable
 * forever. Every Meili task is awaited, so the script reports honest success/failure and exits
 * non-zero if any index fails to rebuild.
 *
 * Run from apps/api: `bun run reindex:all`. Bun auto-loads `.env` (DATABASE_URL, MEILI_*).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { Meilisearch } from 'meilisearch';
import { PrismaClient } from '../generated/prisma/client';
import { reindexIndex, type ReindexClient } from '../src/search/reindex';
import {
  projectApplication,
  projectArticle,
  projectAsset,
  projectInfraNode,
  projectLocation,
  projectUser,
} from '../src/search/search.documents';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const host = process.env.MEILI_HOST;
if (!host) {
  throw new Error('MEILI_HOST is not set — cannot reindex');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const meili = new Meilisearch({ host, apiKey: process.env.MEILI_MASTER_KEY });

async function reindex(): Promise<void> {
  const [assets, articles, users, locations, applications, infra] =
    await Promise.all([
      prisma.asset.findMany({ where: { deletedAt: null } }),
      // Draft privacy (ADR-0022): only PUBLISHED articles are searchable.
      prisma.article.findMany({
        where: { deletedAt: null, status: 'PUBLISHED' },
      }),
      prisma.user.findMany({ where: { deletedAt: null } }),
      prisma.location.findMany({ where: { deletedAt: null } }),
      prisma.application.findMany({ where: { deletedAt: null } }),
      // Infra topology nodes (ADR-0070 v1): soft-deleted nodes are off the map. Join the linked
      // Asset's `name` for the searchable `assetName` (null when graph-only).
      prisma.infraNode.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          label: true,
          kind: true,
          status: true,
          state: true,
          ipAddress: true,
          asset: { select: { name: true } },
        },
      }),
    ]);

  // `Meilisearch` structurally satisfies the small ReindexClient surface reindexIndex depends on.
  const client = meili as unknown as ReindexClient;

  // Rebuild each index authoritatively (temp index + atomic swap → ghosts evicted). Sequential so a
  // failure is attributable and we never run five concurrent rebuilds against a recovering engine.
  await reindexIndex(client, 'assets', assets.map(projectAsset));
  await reindexIndex(client, 'articles', articles.map(projectArticle));
  await reindexIndex(client, 'users', users.map(projectUser));
  await reindexIndex(client, 'locations', locations.map(projectLocation));
  await reindexIndex(
    client,
    'applications',
    applications.map(projectApplication),
  );
  await reindexIndex(client, 'infra', infra.map(projectInfraNode));

  console.log('Reindex complete (full rebuild — stale documents evicted):');
  console.log(`  assets:       ${assets.length}`);
  console.log(`  articles:     ${articles.length} (PUBLISHED only)`);
  console.log(`  users:        ${users.length}`);
  console.log(`  locations:    ${locations.length}`);
  console.log(`  applications: ${applications.length}`);
  console.log(`  infra:        ${infra.length}`);
}

reindex()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error('Reindex failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
