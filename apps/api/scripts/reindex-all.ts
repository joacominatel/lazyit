/**
 * Reindex every Meilisearch index from the database (ADR-0035). Run on first deploy and to repair
 * drift after Meili downtime. Standalone bun script — NOT wired into Nest — so it carries its own
 * PrismaClient (Postgres adapter + DATABASE_URL) and Meilisearch client.
 *
 * Because it bypasses the Nest soft-delete extension (ADR-0032), every fetch filters `deletedAt:
 * null` explicitly; articles are additionally restricted to PUBLISHED to honor draft privacy
 * (ADR-0022) — soft-deleted/draft rows must never end up in the index.
 *
 * Run from apps/api: `bun run reindex:all`. Bun auto-loads `.env` (DATABASE_URL, MEILI_*).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { Meilisearch } from 'meilisearch';
import { PrismaClient } from '../generated/prisma/client';
import {
  projectApplication,
  projectArticle,
  projectAsset,
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
  const [assets, articles, users, locations, applications] = await Promise.all([
    prisma.asset.findMany({ where: { deletedAt: null } }),
    // Draft privacy (ADR-0022): only PUBLISHED articles are searchable.
    prisma.article.findMany({
      where: { deletedAt: null, status: 'PUBLISHED' },
    }),
    prisma.user.findMany({ where: { deletedAt: null } }),
    prisma.location.findMany({ where: { deletedAt: null } }),
    prisma.application.findMany({ where: { deletedAt: null } }),
  ]);

  await Promise.all([
    meili
      .index('assets')
      .addDocuments(assets.map(projectAsset), { primaryKey: 'id' }),
    meili
      .index('articles')
      .addDocuments(articles.map(projectArticle), { primaryKey: 'id' }),
    meili
      .index('users')
      .addDocuments(users.map(projectUser), { primaryKey: 'id' }),
    meili
      .index('locations')
      .addDocuments(locations.map(projectLocation), { primaryKey: 'id' }),
    meili
      .index('applications')
      .addDocuments(applications.map(projectApplication), { primaryKey: 'id' }),
  ]);

  console.log('Reindex enqueued:');
  console.log(`  assets:       ${assets.length}`);
  console.log(`  articles:     ${articles.length} (PUBLISHED only)`);
  console.log(`  users:        ${users.length}`);
  console.log(`  locations:    ${locations.length}`);
  console.log(`  applications: ${applications.length}`);
}

reindex()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error('Reindex failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
