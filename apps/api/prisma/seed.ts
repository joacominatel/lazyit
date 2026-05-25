/**
 * Seeds the initial AssetCategory set. Idempotent (upsert by unique `name`): safe to re-run,
 * and `update: {}` means it never clobbers user edits — categories are user-managed, the seed
 * set is just an initial, non-special list (see docs/02-domain/entities/asset-category.md).
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

// Initial categories. Users can add / edit / soft-delete categories afterwards; none of these
// is special. Icons (heroicon names) are left unset for the frontend to assign.
const INITIAL_CATEGORIES = [
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

async function main() {
  for (const name of INITIAL_CATEGORIES) {
    await prisma.assetCategory.upsert({
      where: { name },
      update: {}, // don't overwrite user edits on re-run
      create: { name },
    });
  }
  console.log(`Seeded ${INITIAL_CATEGORIES.length} asset categories.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
