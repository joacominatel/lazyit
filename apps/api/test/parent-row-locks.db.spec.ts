// Interleaves real writers with a delete of the parent they point at (#1604), against Postgres. Writes rows
// tagged `p1604`: DB_TEST_URL must be a throwaway, migrated Postgres (`bun run test:db`).
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ActorService } from '../src/common/actor.service';
import { AssetHistoryService } from '../src/asset-history/asset-history.service';
import { AssetsService } from '../src/assets/assets.service';
import { LocationsService } from '../src/locations/locations.service';
import { ApplicationsService } from '../src/applications/applications.service';
import { ApplicationCategoriesService } from '../src/application-categories/application-categories.service';
import { ConsumablesService } from '../src/consumables/consumables.service';
import { AssetModelsService } from '../src/asset-models/asset-models.service';
import { AssetCategoriesService } from '../src/asset-categories/asset-categories.service';
import { PurchaseOrdersService } from '../src/purchase-orders/purchase-orders.service';
import type { SearchService } from '../src/search/search.service';
import type { AssetTagSchemeService } from '../src/asset-tag-scheme/asset-tag-scheme.service';
import type { PermissionResolverService } from '../src/auth/permission-resolver.service';
import type { NotificationsService } from '../src/notifications/notifications.service';

// SearchService pulls in the ESM `meilisearch` client; the services get a no-op search instead.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const URL = process.env.DB_TEST_URL;
const TAG = 'p1604';

type Table =
  | 'locations'
  | 'asset_categories'
  | 'application_categories'
  | 'consumable_categories';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The settled outcome of a promise, so a rejection is never left unhandled while the test waits. */
function outcome<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  return p.then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err }),
  );
}

describe('parent row locks against Postgres (#1604)', () => {
  let prisma: PrismaService;
  let assets: AssetsService;
  let locations: LocationsService;
  let applications: ApplicationsService;
  let applicationCategories: ApplicationCategoriesService;
  let consumables: ConsumablesService;
  let models: AssetModelsService;
  let assetCategories: AssetCategoriesService;
  let purchases: PurchaseOrdersService;
  let seq = 0;
  const name = (what: string) => `${TAG}-${what}-${++seq}-${Date.now()}`;

  /** Wait until some backend is blocked on a row lock while running a statement containing `fragment`. */
  const blockedOn = async (fragment: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE ${`%${fragment}%`}`;
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`nothing blocked on a lock running "${fragment}"`);
  };

  /**
   * Play the delete: lock the parent `FOR UPDATE`, let `write` start and block on it, then archive the parent
   * and commit. Returns how the write ended.
   */
  const archiveUnder = async <T>(
    table: Table,
    id: string,
    write: () => Promise<T>,
  ) => {
    const locked = deferred();
    const release = deferred();
    const del = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
          id,
        );
        locked.resolve();
        await release.promise;
        await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "deletedAt" = now() WHERE "id" = $1`,
          id,
        );
      },
      { timeout: 20_000 },
    );
    await locked.promise;
    const result = outcome(write());
    await blockedOn(`FROM "${table}"`);
    release.resolve();
    await del;
    return result;
  };

  const expect400 = (result: { ok: unknown } | { err: unknown }) => {
    expect('err' in result && result.err).toBeInstanceOf(BadRequestException);
  };

  const liveLocation = async () =>
    (
      await prisma.location.create({
        data: { name: name('loc'), type: 'OFFICE' },
      })
    ).id;

  beforeAll(() => {
    if (!URL) {
      throw new Error(
        'DB_TEST_URL is not set: this suite needs a throwaway, migrated Postgres',
      );
    }
    process.env.DATABASE_URL = URL;
    prisma = new PrismaService();
    const actor = new ActorService();
    const history = new AssetHistoryService(prisma);
    const search = {
      upsert: jest.fn(),
      remove: jest.fn(),
    } as unknown as SearchService;
    const permissions = {
      principalHas: () => Promise.resolve(true),
      hasAll: () => Promise.resolve(true),
    } as unknown as PermissionResolverService;
    const tagScheme = {
      allocateTag: () => Promise.resolve(undefined),
    } as unknown as AssetTagSchemeService;
    assets = new AssetsService(
      prisma,
      actor,
      history,
      search,
      tagScheme,
      permissions,
    );
    locations = new LocationsService(
      prisma,
      search,
      actor,
      history,
      permissions,
    );
    applications = new ApplicationsService(prisma, search);
    applicationCategories = new ApplicationCategoriesService(
      prisma,
      permissions,
    );
    consumables = new ConsumablesService(
      prisma,
      actor,
      {} as NotificationsService,
      history,
      permissions,
    );
    models = new AssetModelsService(prisma, actor, history, permissions);
    assetCategories = new AssetCategoriesService(prisma, permissions);
    purchases = new PurchaseOrdersService(prisma, actor);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // --- the delete commits while the write waits: the write sees the parent archived -----------------------

  describe('a delete that holds the parent first wins, and the write is refused', () => {
    it('asset create into the location', async () => {
      const loc = await liveLocation();
      const result = await archiveUnder('locations', loc, () =>
        assets.create({
          name: name('a'),
          status: 'IN_STORAGE',
          locationId: loc,
        }),
      );
      expect400(result);
      expect(await prisma.asset.count({ where: { locationId: loc } })).toBe(0);
    });

    it('asset move into the location', async () => {
      const [from, to] = [await liveLocation(), await liveLocation()];
      const a = await assets.create({
        name: name('a'),
        status: 'IN_STORAGE',
        locationId: from,
      });
      const result = await archiveUnder('locations', to, () =>
        assets.update(a.id, { locationId: to }),
      );
      expect400(result);
      const row = await prisma.asset.findFirstOrThrow({ where: { id: a.id } });
      expect(row.locationId).toBe(from);
    });

    it('purchase receiving into the location (the upfront check passed before the delete committed)', async () => {
      const loc = await liveLocation();
      const model = await models.create({
        name: name('m'),
        manufacturer: TAG,
      });
      const result = await archiveUnder('locations', loc, () =>
        assets.receiveBatch({
          modelId: model.id,
          quantity: 2,
          status: 'IN_STORAGE',
          locationId: loc,
        }),
      );
      // Each unit is its own transaction: every unit is refused under its lock, none lands on the archive.
      expect('ok' in result && result.ok.created).toEqual([]);
      expect('ok' in result && result.ok.failed).toHaveLength(2);
      expect(await prisma.asset.count({ where: { locationId: loc } })).toBe(0);
    });

    it('purchase create and update delivering to the location', async () => {
      const loc = await liveLocation();
      expect400(
        await archiveUnder('locations', loc, () =>
          purchases.create({ reference: name('po'), deliveryLocationId: loc }),
        ),
      );
      const other = await liveLocation();
      const po = await purchases.create({ reference: name('po') });
      expect400(
        await archiveUnder('locations', other, () =>
          purchases.update(po.id, { deliveryLocationId: other }),
        ),
      );
      const row = await prisma.purchaseOrder.findFirstOrThrow({
        where: { id: po.id },
      });
      expect(row.deliveryLocationId).toBeNull();
    });

    it('application create and re-categorisation', async () => {
      const cat = await prisma.applicationCategory.create({
        data: { name: name('ac') },
      });
      expect400(
        await archiveUnder('application_categories', cat.id, () =>
          applications.create({
            name: name('app'),
            isCritical: false,
            categoryId: cat.id,
          }),
        ),
      );
      const next = await prisma.applicationCategory.create({
        data: { name: name('ac') },
      });
      const app = await applications.create({
        name: name('app'),
        isCritical: false,
      });
      expect400(
        await archiveUnder('application_categories', next.id, () =>
          applications.update(app.id, { categoryId: next.id }),
        ),
      );
    });

    it('consumable create and re-categorisation', async () => {
      const cat = await prisma.consumableCategory.create({
        data: { name: name('cc') },
      });
      expect400(
        await archiveUnder('consumable_categories', cat.id, () =>
          consumables.create({
            name: name('k'),
            unit: 'u',
            categoryId: cat.id,
          }),
        ),
      );
      const next = await prisma.consumableCategory.create({
        data: { name: name('cc') },
      });
      const k = await consumables.create({ name: name('k'), unit: 'u' });
      expect400(
        await archiveUnder('consumable_categories', next.id, () =>
          consumables.update(k.id, { categoryId: next.id }),
        ),
      );
    });

    it('asset model create and re-categorisation', async () => {
      const cat = await prisma.assetCategory.create({
        data: { name: name('mc') },
      });
      expect400(
        await archiveUnder('asset_categories', cat.id, () =>
          models.create({
            name: name('m'),
            manufacturer: TAG,
            categoryId: cat.id,
          }),
        ),
      );
      const next = await prisma.assetCategory.create({
        data: { name: name('mc') },
      });
      const m = await models.create({ name: name('m'), manufacturer: TAG });
      expect400(
        await archiveUnder('asset_categories', next.id, () =>
          models.update(m.id, { categoryId: next.id }),
        ),
      );
    });
  });

  // --- the write holds the parent first: the real delete waits, then resolves the new row -----------------

  describe('a write that holds the parent first commits, and the real delete then resolves it', () => {
    /** Run `write` holding `table`.`id` FOR SHARE, start `del`, and commit the write once `del` is blocked. */
    const writeUnder = async (
      table: Table,
      id: string,
      write: (tx: Prisma.TransactionClient) => Promise<unknown>,
      del: () => Promise<unknown>,
    ) => {
      const wrote = deferred();
      const release = deferred();
      const writer = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR SHARE`,
            id,
          );
          await write(tx);
          wrote.resolve();
          await release.promise;
        },
        { timeout: 20_000 },
      );
      await wrote.promise;
      const deletion = outcome(del());
      await blockedOn(`FROM "${table}"`);
      release.resolve();
      await writer;
      return deletion;
    };

    it('the location delete locks its own row before scanning, so an asset created meanwhile is detached', async () => {
      const loc = await liveLocation();
      let assetId = '';
      const deletion = await writeUnder(
        'locations',
        loc,
        async (tx) => {
          assetId = (
            await tx.asset.create({
              data: { name: name('a'), status: 'IN_STORAGE', locationId: loc },
            })
          ).id;
        },
        () => locations.remove(loc, { strategy: 'detach' }),
      );
      expect('ok' in deletion).toBe(true);
      const row = await prisma.asset.findFirstOrThrow({
        where: { id: assetId },
      });
      expect(row.locationId).toBeNull();
    });

    it('the location delete moves a purchase pointed at it meanwhile to the target', async () => {
      const [loc, target] = [await liveLocation(), await liveLocation()];
      const po = await purchases.create({ reference: name('po') });
      const deletion = await writeUnder(
        'locations',
        loc,
        (tx) =>
          tx.purchaseOrder.update({
            where: { id: po.id },
            data: { deliveryLocationId: loc },
          }),
        () => locations.remove(loc, { strategy: 'move', targetId: target }),
      );
      expect('ok' in deletion).toBe(true);
      const row = await prisma.purchaseOrder.findFirstOrThrow({
        where: { id: po.id },
      });
      expect(row.deliveryLocationId).toBe(target);
    });

    it('an application category delete moves an application filed under it meanwhile', async () => {
      const [cat, target] = [
        await prisma.applicationCategory.create({ data: { name: name('ac') } }),
        await prisma.applicationCategory.create({ data: { name: name('ac') } }),
      ];
      const app = await applications.create({
        name: name('app'),
        isCritical: false,
      });
      const deletion = await writeUnder(
        'application_categories',
        cat.id,
        (tx) =>
          tx.application.update({
            where: { id: app.id },
            data: { categoryId: cat.id },
          }),
        () =>
          applicationCategories.remove(cat.id, {
            strategy: 'move',
            targetId: target.id,
          }),
      );
      expect('ok' in deletion).toBe(true);
      const row = await prisma.application.findFirstOrThrow({
        where: { id: app.id },
      });
      expect(row.categoryId).toBe(target.id);
    });

    it('an asset category delete detaches a model filed under it meanwhile', async () => {
      const cat = await prisma.assetCategory.create({
        data: { name: name('mc') },
      });
      const m = await models.create({ name: name('m'), manufacturer: TAG });
      const deletion = await writeUnder(
        'asset_categories',
        cat.id,
        (tx) =>
          tx.assetModel.update({
            where: { id: m.id },
            data: { categoryId: cat.id },
          }),
        () => assetCategories.remove(cat.id, { strategy: 'detach' }),
      );
      expect('ok' in deletion).toBe(true);
      const row = await prisma.assetModel.findFirstOrThrow({
        where: { id: m.id },
      });
      expect(row.categoryId).toBeNull();
    });
  });

  // --- real writers racing a real delete: no deadlock, nothing stranded ------------------------------------

  it('concurrent moves and receives into a location racing its delete never deadlock or strand an asset', async () => {
    for (let round = 0; round < 5; round++) {
      const [loc, target, home] = [
        await liveLocation(),
        await liveLocation(),
        await liveLocation(),
      ];
      const moving = await Promise.all(
        Array.from({ length: 4 }, () =>
          assets.create({
            name: name('a'),
            status: 'IN_STORAGE',
            locationId: home,
          }),
        ),
      );
      // Some assets already sit at the location, so the delete has rows to lock while the writers run.
      await Promise.all(
        Array.from({ length: 3 }, () =>
          assets.create({
            name: name('a'),
            status: 'IN_STORAGE',
            locationId: loc,
          }),
        ),
      );
      const results = await Promise.all([
        ...moving.map((a) => outcome(assets.update(a.id, { locationId: loc }))),
        outcome(
          assets.create({
            name: name('a'),
            status: 'IN_STORAGE',
            locationId: loc,
          }),
        ),
        outcome(locations.remove(loc, { strategy: 'move', targetId: target })),
      ]);
      // The delete itself always goes through: it resolves whatever committed before it.
      expect('ok' in results[results.length - 1]).toBe(true);
      for (const result of results) {
        if ('err' in result) {
          // Only the domain refusal is acceptable: never a deadlock (40P01) or a timeout.
          expect(result.err).toBeInstanceOf(BadRequestException);
        }
      }
      expect(
        await prisma.asset.count({
          where: { locationId: loc, deletedAt: null },
        }),
      ).toBe(0);
    }
  });
});
