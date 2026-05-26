/**
 * Seeds the initial AssetCategory, ArticleCategory and ApplicationCategory sets. Idempotent (upsert
 * by unique `name`): safe to re-run, and `update: {}` means it never clobbers user edits — all three
 * category sets are user-managed, the seed lists are just an initial, non-special starting point (see
 * docs/02-domain/entities/asset-category.md, article-category.md and application-category.md).
 *
 * Run from apps/api: `bunx prisma db seed`.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Initial asset categories. Users can add / edit / soft-delete categories afterwards; none of
// these is special. Icons (heroicon names) are left unset for the frontend to assign.
const INITIAL_ASSET_CATEGORIES = [
  'Server',
  'Switch',
  'Router',
  'Firewall',
  'Laptop',
  'Desktop',
  'Mobile',
  'Printer',
  'Storage',
  'UPS',
  'Peripheral',
  'Other',
];

// Initial knowledge-base categories. Same user-managed, non-special nature. `icon` is a heroicon
// name for the web UI; `order` (seeded by position) sorts the sidebar — all editable afterwards.
const INITIAL_ARTICLE_CATEGORIES: { name: string; icon: string }[] = [
  { name: 'Networking', icon: 'GlobeAltIcon' },
  { name: 'Servers', icon: 'ServerStackIcon' },
  { name: 'Access Management', icon: 'KeyIcon' },
  { name: 'Datacenter', icon: 'BuildingOfficeIcon' },
  { name: 'Procedures', icon: 'ClipboardDocumentListIcon' },
  { name: 'Troubleshooting', icon: 'WrenchScrewdriverIcon' },
  { name: 'Onboarding', icon: 'UserPlusIcon' },
  { name: 'Tools', icon: 'Cog6ToothIcon' },
];

// Initial application categories (what an access target is: a SaaS product, an internal system, a
// technical service, …). Same user-managed, non-special nature; `icon` is a heroicon name and
// `order` (seeded by position) sorts the listing — all editable afterwards. See ADR-0023.
const INITIAL_APPLICATION_CATEGORIES: { name: string; icon: string }[] = [
  { name: 'SaaS', icon: 'CloudIcon' },
  { name: 'Internal', icon: 'BuildingOffice2Icon' },
  { name: 'Service', icon: 'WrenchScrewdriverIcon' },
  { name: 'Third Party', icon: 'BuildingStorefrontIcon' },
  { name: 'Infrastructure', icon: 'ServerStackIcon' },
  { name: 'Other', icon: 'Squares2X2Icon' },
];

// Initial consumable categories (stock-counted supplies — cables, adapters, …). Same user-managed,
// non-special nature; `order` (seeded by position) sorts the listing — all editable afterwards.
// Icons (heroicon names) are left unset for the frontend to assign. See ADR-0034.
const INITIAL_CONSUMABLE_CATEGORIES = [
  'Cables',
  'Adapters',
  'Peripherals',
  'Office supplies',
  'Other',
];

async function main() {
  for (const name of INITIAL_ASSET_CATEGORIES) {
    await prisma.assetCategory.upsert({
      where: { name },
      update: {}, // don't overwrite user edits on re-run
      create: { name },
    });
  }
  console.log(`Seeded ${INITIAL_ASSET_CATEGORIES.length} asset categories.`);

  for (const [index, { name, icon }] of INITIAL_ARTICLE_CATEGORIES.entries()) {
    await prisma.articleCategory.upsert({
      where: { name },
      update: {}, // don't overwrite user edits on re-run
      create: { name, icon, order: index + 1 },
    });
  }
  console.log(`Seeded ${INITIAL_ARTICLE_CATEGORIES.length} article categories.`);

  for (const [index, { name, icon }] of INITIAL_APPLICATION_CATEGORIES.entries()) {
    await prisma.applicationCategory.upsert({
      where: { name },
      update: {}, // don't overwrite user edits on re-run
      create: { name, icon, order: index + 1 },
    });
  }
  console.log(
    `Seeded ${INITIAL_APPLICATION_CATEGORIES.length} application categories.`,
  );

  for (const [index, name] of INITIAL_CONSUMABLE_CATEGORIES.entries()) {
    await prisma.consumableCategory.upsert({
      where: { name },
      update: {}, // don't overwrite user edits on re-run
      create: { name, order: index + 1 },
    });
  }
  console.log(
    `Seeded ${INITIAL_CONSUMABLE_CATEGORIES.length} consumable categories.`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
