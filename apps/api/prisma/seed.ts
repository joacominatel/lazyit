/**
 * Seeds an initial ADMIN user and the initial AssetCategory, ArticleCategory, ApplicationCategory and
 * ConsumableCategory sets. Idempotent: safe to re-run.
 *
 * Since ADR-0041, the natural keys (`User.email`, `*.name`) are NO LONGER full `@unique` columns —
 * uniqueness is a PARTIAL unique index scoped to live rows (`WHERE "deletedAt" IS NULL`), which
 * Prisma can't use as a `where` unique key.
 *
 * Category sets are seeded **once, per table**: each reference set is created only when its table is
 * empty (zero rows, live OR soft-deleted). The earlier per-name `findFirst({ where: { name } })`
 * then create was NOT rename-safe — renaming a seeded category (e.g. `Adapters` → `Adaptadores`)
 * made the next `db seed` miss the old name and RE-CREATE it, duplicating the row (#321). Seeding
 * once off a table-level count is rename-safe and never clobbers user edits: all category sets are
 * user-managed, the seed lists are just an initial, non-special starting point (see
 * docs/02-domain/entities/asset-category.md etc.). The seeded user is ADMIN (ADR-0040): a
 * freshly-seeded database must always have at least one administrator.
 *
 * It also seeds the RolePermission matrix (Roles & Permissions v2 — ADR-0046): each fixed Role mapped
 * to its `domain:action` permissions, taken 1:1 from `DEFAULT_ROLE_PERMISSIONS` in `@lazyit/shared`
 * (the single source of truth the golden test also asserts against). Idempotent upsert per row.
 *
 * Run from apps/api: `bunx prisma db seed`.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { DEFAULT_ROLE_PERMISSIONS } from '@lazyit/shared';
import { PrismaClient, Role } from '../generated/prisma/client';
import { seedCategoriesOnce } from '../src/prisma/seed-categories';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// The seeded administrator — DEV CONVENIENCE ONLY, OPT-IN (#333). Seeded ONLY when SEED_ADMIN_EMAIL
// is explicitly set; there is NO default. In a prod / zero-touch deploy SEED_ADMIN_EMAIL is UNSET, so
// NO admin is seeded and the in-app /setup wizard — or the first OIDC login, which jwt-auth.guard's
// jitProvision promotes to ADMIN on an empty DB — owns the first administrator (ADR-0043). A
// pre-seeded admin otherwise breaks BOTH first-run paths: it trips /setup's `adminCount > 0` gate
// ("Already set up") AND makes the first real OIDC login default to VIEWER (`userCount !== 0`),
// because the operator's IdP email never matches the seed's `admin@lazyit.local`. For local dev with
// the X-User-Id shim, set SEED_ADMIN_EMAIL=admin@lazyit.local in apps/api/.env. Bun auto-loads .env.
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim() || undefined;

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
  // Seeded administrator — OPT-IN (#333). Only runs when SEED_ADMIN_EMAIL is set (dev convenience for
  // the X-User-Id shim). In prod / zero-touch the var is UNSET, so the seed creates NO user and the
  // /setup wizard (or the first OIDC login → ADMIN) owns the first administrator (ADR-0043). When set:
  // ADMIN so a fresh dev database is never left without anyone able to administer it; the email is
  // normalized (citext + ADR-0041) to its canonical lowercase form so the find matches the
  // case-insensitive column; re-asserts the ADMIN role on re-run (corrects a manual dev demotion);
  // creates the row only when no LIVE admin with that email exists.
  if (SEED_ADMIN_EMAIL) {
    const adminEmail = SEED_ADMIN_EMAIL.toLowerCase();
    const existingAdmin = await prisma.user.findFirst({
      where: { email: adminEmail, deletedAt: null },
      select: { id: true },
    });
    if (existingAdmin) {
      await prisma.user.update({
        where: { id: existingAdmin.id },
        data: { role: Role.ADMIN },
      });
    } else {
      await prisma.user.create({
        data: {
          email: adminEmail,
          firstName: 'Admin',
          lastName: 'User',
          role: Role.ADMIN,
        },
      });
    }
    console.log(`Seeded ADMIN user ${adminEmail} (SEED_ADMIN_EMAIL set).`);
  } else {
    console.log(
      'No SEED_ADMIN_EMAIL set — skipping admin seed; the /setup wizard or first OIDC login owns the first ADMIN (ADR-0043).',
    );
  }

  // Category sets — seed-once per table (rename-safe; never re-creates a renamed row, #321).
  const assetCreated = await seedCategoriesOnce(
    prisma.assetCategory,
    INITIAL_ASSET_CATEGORIES.map((name) => ({ name })),
  );
  console.log(
    assetCreated > 0
      ? `Seeded ${assetCreated} asset categories.`
      : 'Asset categories already present — skipped (seed-once).',
  );

  const articleCreated = await seedCategoriesOnce(
    prisma.articleCategory,
    INITIAL_ARTICLE_CATEGORIES.map(({ name, icon }, index) => ({
      name,
      icon,
      order: index + 1,
    })),
  );
  console.log(
    articleCreated > 0
      ? `Seeded ${articleCreated} article categories.`
      : 'Article categories already present — skipped (seed-once).',
  );

  const applicationCreated = await seedCategoriesOnce(
    prisma.applicationCategory,
    INITIAL_APPLICATION_CATEGORIES.map(({ name, icon }, index) => ({
      name,
      icon,
      order: index + 1,
    })),
  );
  console.log(
    applicationCreated > 0
      ? `Seeded ${applicationCreated} application categories.`
      : 'Application categories already present — skipped (seed-once).',
  );

  const consumableCreated = await seedCategoriesOnce(
    prisma.consumableCategory,
    INITIAL_CONSUMABLE_CATEGORIES.map((name, index) => ({
      name,
      order: index + 1,
    })),
  );
  console.log(
    consumableCreated > 0
      ? `Seeded ${consumableCreated} consumable categories.`
      : 'Consumable categories already present — skipped (seed-once).',
  );

  // RolePermission matrix (ADR-0046). Seed each Role → permission pair from the shared single source
  // of truth (DEFAULT_ROLE_PERMISSIONS). Idempotent: the composite PK (role, permission) makes a
  // re-run a no-op upsert. This is purely additive groundwork — nothing in the API reads these rows
  // yet (the @RequirePermission guard is a later wave); the seed exists so the table is populated and
  // the golden test can assert it. NOTE: this does NOT delete permissions removed from the catalog;
  // pruning stale rows is a config-endpoint concern (a later wave), not a seed concern.
  let permissionRowCount = 0;
  for (const [role, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { role_permission: { role: role as Role, permission } },
        create: { role: role as Role, permission },
        update: {},
      });
      permissionRowCount += 1;
    }
  }
  console.log(`Seeded ${permissionRowCount} role-permission rows.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
