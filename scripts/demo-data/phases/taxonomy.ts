import type {
  ApplicationCategory,
  AssetCategory,
  AssetModel,
  AssetStatusLabel,
  AssetTagScheme,
  ConsumableCategory,
  CreateAssetModel,
  CreateAssetStatusLabel,
  CreateLocation,
  CreateSupplier,
  Location,
  LocationType,
  Supplier,
  UpdateAssetTagScheme,
} from "@lazyit/shared";
import { pool } from "../lib/api";
import { type Ctx, modelKey } from "../lib/context";
import { rngFor, slugify } from "../lib/rng";
import {
  APPLICATION_CATEGORY_RENAMES,
  APPLICATION_CATEGORY_SEEDS,
  ARCHIVED_MODEL_COUNT,
  ARCHIVED_SUPPLIERS,
  ASSET_CATEGORY_RENAMES,
  ASSET_CATEGORY_SEEDS,
  CONSUMABLE_CATEGORY_RENAMES,
  CONSUMABLE_CATEGORY_SEEDS,
  FIRST_NAMES,
  LAPTOP_SPECS_SCHEMA,
  LAST_NAMES,
  MODELS,
  type ModelSeed,
  STATUS_LABELS,
  SUPPLIERS,
} from "../lib/words";

type Category = AssetCategory | ApplicationCategory | ConsumableCategory;

// A seeded name that this script renamed resolves through its new name.
export function categoryId(
  map: Map<string, string>,
  name: string,
  renames: readonly (readonly [string, string])[],
): string | undefined {
  return map.get(name) ?? map.get(renames.find(([from]) => from === name)?.[1] ?? "");
}

async function ensureCategories(
  ctx: Ctx,
  path: string,
  entity: string,
  renames: readonly (readonly [string, string])[],
  seeds: readonly { name: string; description: string; icon?: string }[],
  into: Map<string, string>,
): Promise<Category[]> {
  const { api, report } = ctx;
  const live = await api.all<Category>(path);
  const byName = new Map(live.map((c) => [c.name, c]));
  for (const [from, to] of renames) {
    const source = byName.get(from);
    if (!source || byName.has(to)) {
      report.skipped("category rename");
      continue;
    }
    try {
      const renamed = await api.patch<Category>(`${path}/${source.id}`, { name: to });
      byName.delete(from);
      byName.set(to, renamed);
      report.created("category rename");
    } catch (err) {
      report.failed("category rename", `${from} -> ${to}`, err);
    }
  }
  for (const seed of seeds) {
    if (byName.has(seed.name)) {
      report.skipped(entity);
      continue;
    }
    try {
      const created = await api.post<Category>(path, seed);
      byName.set(created.name, created);
      report.created(entity);
    } catch (err) {
      report.failed(entity, seed.name, err);
    }
  }
  for (const [name, category] of byName) into.set(name, category.id);
  return [...byName.values()];
}

interface LocationSeed extends CreateLocation {
  path: string;
  parentPath?: string;
}

export function selectModels(seed: string, count: number): ModelSeed[] {
  const active = MODELS.slice(0, MODELS.length - ARCHIVED_MODEL_COUNT);
  const keep = new Set(active);
  const perCategory = new Map<string, number>();
  for (const m of active) perCategory.set(m.category, (perCategory.get(m.category) ?? 0) + 1);
  let toDrop = MODELS.length - count;
  for (const m of rngFor(seed, "models").sample(active, active.length)) {
    if (toDrop <= 0) break;
    if ((perCategory.get(m.category) ?? 0) < 2) continue;
    keep.delete(m);
    perCategory.set(m.category, perCategory.get(m.category)! - 1);
    toDrop--;
  }
  return [...active.filter((m) => keep.has(m)), ...MODELS.slice(MODELS.length - ARCHIVED_MODEL_COUNT)];
}

export function locationPlan(seed: string): LocationSeed[] {
  const rng = rngFor(seed, "locations");
  const out: LocationSeed[] = [];
  const add = (parentPath: string | undefined, name: string, type: LocationType, extra: Partial<CreateLocation> = {}) => {
    const path = parentPath ? `${parentPath}/${name}` : name;
    out.push({ path, parentPath, name, type, ...extra });
    return path;
  };
  const offices: [string, string, string, [string, number, number][]][] = [
    ["Buenos Aires HQ", "Av. Corrientes 1234, C1043 CABA, Argentina", "BUE", [["Torre Norte", 4, 2], ["Torre Sur", 2, 2]]],
    ["Madrid Office", "Paseo de la Castellana 95, 28046 Madrid, Spain", "MAD", [["Edificio Castellana", 3, 2]]],
    ["Austin Office", "500 W 2nd St, Austin, TX 78701, USA", "AUS", [["Building 1", 2, 2], ["Building 2", 1, 2]]],
  ];
  for (const [site, address, code, buildings] of offices) {
    const sitePath = add(undefined, site, "OFFICE", { address, description: `${code} campus` });
    for (const [building, floors, rooms] of buildings) {
      const buildingPath = add(sitePath, building, "OFFICE");
      for (let f = 1; f <= floors; f++) {
        const floorPath = add(buildingPath, `Floor ${f}`, "OFFICE", { floor: String(f) });
        const roomCount = Math.max(1, rooms + rng.int(-1, 1));
        for (let r = 1; r <= roomCount; r++) {
          add(floorPath, `Room ${f}.${String(r).padStart(2, "0")}`, "OFFICE", { floor: String(f) });
        }
      }
    }
    const it = add(sitePath, `${code} IT Storage`, "STORAGE", { notes: "Spare stock and returned devices" });
    add(it, "Cage A", "STORAGE");
  }
  const dc = add("Buenos Aires HQ", "BUE Datacenter", "DATACENTER", { floor: "B1" });
  for (const rack of ["A01", "A02", "A03", "B01", "B02"]) add(dc, `Rack ${rack}`, "RACK");
  const comms = add("Madrid Office", "MAD Comms Room", "DATACENTER", { floor: "0" });
  add(comms, "Rack C01", "RACK");
  const colo = add(undefined, "Colocation SP4", "DATACENTER", { address: "Av. Industrial 400, Santana de Parnaíba, Brazil" });
  for (const rack of ["R12", "R13"]) add(colo, `Rack ${rack}`, "RACK");
  add(undefined, "Remote workers", "REMOTE", { description: "Devices shipped to home offices" });
  add(undefined, "Vendor repair (off-site)", "OTHER", { description: "Devices at the manufacturer or a repair shop" });
  if (out.length % 10 === 0) add("Austin Office/AUS IT Storage", "Cage B", "STORAGE");
  return out;
}

async function ensureLocations(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const [live, archived] = await Promise.all([
    api.all<Location>("/locations", { sort: "name" }),
    api.all<Location>("/locations", { deleted: "only", sort: "name" }),
  ]);
  const all = [...live, ...archived];
  const byId = new Map(all.map((l) => [l.id, l]));
  const pathOf = (l: Location): string => {
    const parts: string[] = [];
    for (let cur: Location | undefined = l, guard = 0; cur && guard < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined, guard++) {
      parts.unshift(cur.name);
    }
    return parts.join("/");
  };
  const existing = new Map(all.map((l) => [pathOf(l), l]));
  const plan = locationPlan(ctx.seed);
  const depth = (p: string) => p.split("/").length;
  const maxDepth = Math.max(...plan.map((p) => depth(p.path)));
  for (let d = 1; d <= maxDepth; d++) {
    await pool(plan.filter((p) => depth(p.path) === d), ctx.concurrency, async (seed) => {
      const found = existing.get(seed.path);
      if (found) {
        ctx.locations.set(seed.path, { id: found.id, type: found.type });
        report.skipped("location");
        return;
      }
      const parent = seed.parentPath ? ctx.locations.get(seed.parentPath) : undefined;
      if (seed.parentPath && !parent) {
        report.failed("location", seed.path, new Error("parent location missing"));
        return;
      }
      const { path, parentPath, ...body } = seed;
      try {
        const created = await api.post<Location>("/locations", { ...body, ...(parent ? { parentId: parent.id } : {}) });
        ctx.locations.set(path, { id: created.id, type: created.type });
        report.created("location");
      } catch (err) {
        report.failed("location", path, err);
      }
    });
  }
}

async function ensureLabels(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const [live, archived] = await Promise.all([
    api.get<AssetStatusLabel[]>("/asset-status-labels"),
    api.get<AssetStatusLabel[]>("/asset-status-labels", { deleted: "only" }),
  ]);
  const byName = new Map([...archived, ...live].map((l) => [l.name, l]));
  for (const [order, seed] of STATUS_LABELS.slice(0, ctx.taxa.statusLabels).entries()) {
    const found = byName.get(seed.name);
    if (found) {
      if (!found.deletedAt) ctx.labels.set(seed.name, { id: found.id, kind: found.kind });
      report.skipped("status label");
      continue;
    }
    const body: CreateAssetStatusLabel = { ...seed, order: order * 10 };
    try {
      const created = await api.post<AssetStatusLabel>("/asset-status-labels", body);
      ctx.labels.set(seed.name, { id: created.id, kind: created.kind });
      report.created("status label");
    } catch (err) {
      report.failed("status label", seed.name, err);
    }
  }
}

async function ensureSuppliers(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const [live, archived] = await Promise.all([
    api.all<Supplier>("/suppliers", { sort: "name" }),
    api.all<Supplier>("/suppliers", { deleted: "only", sort: "name" }),
  ]);
  const byName = new Map([...archived, ...live].map((s) => [s.name, s]));
  await pool(SUPPLIERS.slice(0, ctx.taxa.suppliers), ctx.concurrency, async (name, i) => {
    let supplier = byName.get(name);
    if (supplier) {
      report.skipped("supplier");
    } else {
      const rng = rngFor(ctx.seed, "supplier", i);
      const domain = `${slugify(name).replace(/-/g, "")}.test`;
      const contact = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
      const body: CreateSupplier = {
        name,
        taxId: rng.chance(0.7) ? `30-${rng.int(10_000_000, 99_999_999)}-${rng.int(0, 9)}` : undefined,
        website: `https://www.${domain}`,
        salesContactName: contact,
        salesContactEmail: `sales@${domain}`,
        salesContactPhone: `+54 11 ${rng.int(4000, 4999)}-${rng.int(1000, 9999)}`,
        supportContactName: rng.chance(0.6) ? `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}` : undefined,
        supportContactEmail: rng.chance(0.6) ? `support@${domain}` : undefined,
        notes: rng.chance(0.3) ? "Net 30 payment terms. Quote validity 15 days." : undefined,
      };
      try {
        supplier = await api.post<Supplier>("/suppliers", body);
        report.created("supplier");
      } catch (err) {
        report.failed("supplier", name, err);
        return;
      }
    }
    if ((ARCHIVED_SUPPLIERS as readonly string[]).includes(name)) {
      if (supplier.deletedAt) {
        report.skipped("supplier archive");
      } else {
        try {
          await api.delete(`/suppliers/${supplier.id}`);
          report.created("supplier archive");
        } catch (err) {
          report.failed("supplier archive", name, err);
        }
      }
      return;
    }
    ctx.suppliers.set(name, supplier.id);
  });
}

async function ensureModels(ctx: Ctx, categories: Map<string, string>): Promise<void> {
  const { api, report } = ctx;
  const [live, archived] = await Promise.all([
    api.all<AssetModel>("/asset-models", { sort: "sku" }),
    api.all<AssetModel>("/asset-models", { deleted: "only", sort: "sku" }),
  ]);
  const byKey = new Map([...archived, ...live].map((m) => [modelKey(m.manufacturer, m.name), m]));
  const models = selectModels(ctx.seed, ctx.taxa.assetModels);
  const archivedFrom = models.length - ARCHIVED_MODEL_COUNT;
  await pool(models, ctx.concurrency, async (seed, i) => {
    const key = modelKey(seed.manufacturer, seed.name);
    let model = byKey.get(key);
    if (model) {
      report.skipped("asset model");
    } else {
      const categoryIdValue = categoryId(categories, seed.category, ASSET_CATEGORY_RENAMES);
      const body: CreateAssetModel = {
        name: seed.name,
        manufacturer: seed.manufacturer,
        sku: `${seed.manufacturer.slice(0, 3).toUpperCase()}-${slugify(seed.name).toUpperCase().slice(0, 24)}`,
        specs: seed.specs,
        ...(categoryIdValue ? { categoryId: categoryIdValue } : {}),
      };
      try {
        model = await api.post<AssetModel>("/asset-models", body);
        report.created("asset model");
      } catch (err) {
        report.failed("asset model", key, err);
        return;
      }
    }
    if (i >= archivedFrom) {
      if (model.deletedAt) {
        report.skipped("asset model archive");
      } else {
        try {
          await api.delete(`/asset-models/${model.id}`);
          report.created("asset model archive");
        } catch (err) {
          report.failed("asset model archive", key, err);
        }
      }
      return;
    }
    if (!model.deletedAt) ctx.models.set(key, { id: model.id, category: seed.category });
  });
}

async function ensureTagScheme(ctx: Ctx): Promise<void> {
  const scheme = await ctx.api.get<AssetTagScheme>("/config/asset-tag-scheme");
  if (scheme.enabled) {
    ctx.report.skipped("asset tag scheme");
    return;
  }
  const body: UpdateAssetTagScheme = { enabled: true, prefix: "ACME-", width: 5, startNumber: Math.max(1, scheme.nextNumber) };
  try {
    await ctx.api.put("/config/asset-tag-scheme", body);
    ctx.report.created("asset tag scheme");
  } catch (err) {
    ctx.report.failed("asset tag scheme", "scheme", err);
  }
}

export async function runTaxonomy(ctx: Ctx): Promise<void> {
  const assetCategories = await ensureCategories(
    ctx,
    "/asset-categories",
    "asset category",
    ASSET_CATEGORY_RENAMES,
    ASSET_CATEGORY_SEEDS,
    ctx.assetCategories,
  );
  const laptop = (assetCategories as AssetCategory[]).find((c) => c.name === "Laptop");
  if (laptop && !laptop.specsSchema) {
    try {
      await ctx.api.patch(`/asset-categories/${laptop.id}`, { specsSchema: LAPTOP_SPECS_SCHEMA });
      ctx.report.created("category specs schema");
    } catch (err) {
      ctx.report.failed("category specs schema", "Laptop", err);
    }
  } else {
    ctx.report.skipped("category specs schema");
  }
  await ensureCategories(
    ctx,
    "/application-categories",
    "application category",
    APPLICATION_CATEGORY_RENAMES,
    APPLICATION_CATEGORY_SEEDS,
    ctx.applicationCategories,
  );
  await ensureCategories(
    ctx,
    "/consumable-categories",
    "consumable category",
    CONSUMABLE_CATEGORY_RENAMES,
    CONSUMABLE_CATEGORY_SEEDS,
    ctx.consumableCategories,
  );
  await ensureLocations(ctx);
  await ensureLabels(ctx);
  await ensureSuppliers(ctx);
  await ensureModels(ctx, ctx.assetCategories);
  await ensureTagScheme(ctx);
}

export const TAXONOMY_ENTITIES = [
  "category rename",
  "asset category",
  "category specs schema",
  "application category",
  "consumable category",
  "location",
  "status label",
  "supplier",
  "supplier archive",
  "asset model",
  "asset model archive",
  "asset tag scheme",
];
