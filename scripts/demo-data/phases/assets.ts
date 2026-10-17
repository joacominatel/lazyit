import type { Asset, AssetAssignment, AssetListItem, AssetStatus, CreateAsset, CreateAssetAssignment } from "@lazyit/shared";
import { pool } from "../lib/api";
import { type Ctx, sortedEntries } from "../lib/context";
import { type Rng, rngFor } from "../lib/rng";
import { COMPANIES, MODELS, STATUS_LABELS } from "../lib/words";

const END_USER = new Set(["Laptop", "Desktop", "Monitor", "Mobile", "Tablet", "Docking Station", "Peripheral"]);
const ROOM_GEAR = new Set(["Access Point", "VoIP Phone", "Conference Room Kit", "Printer", "Other"]);

const CATEGORY_WEIGHTS: [string, number][] = [
  ["Laptop", 38], ["Desktop", 7], ["Monitor", 16], ["Mobile", 9], ["Tablet", 3], ["Docking Station", 6],
  ["Peripheral", 6], ["Printer", 1.5], ["Server", 3], ["Switch", 2], ["Router", 0.6], ["Firewall", 0.6],
  ["Storage", 0.5], ["UPS", 0.8], ["Access Point", 3], ["VoIP Phone", 2], ["Conference Room Kit", 1], ["Other", 0.5],
];

const NAME_PREFIX: Record<string, string> = {
  Laptop: "LT", Desktop: "DT", Monitor: "MON", Mobile: "PH", Tablet: "TAB", "Docking Station": "DCK",
  Peripheral: "PER", Printer: "PRN", Server: "SRV", Switch: "SW", Router: "RTR", Firewall: "FW", Storage: "NAS",
  UPS: "UPS", "Access Point": "AP", "VoIP Phone": "VOIP", "Conference Room Kit": "CONF", Other: "OTH",
};

const PRICE_CENTS: Record<string, [number, number]> = {
  Laptop: [90_000, 320_000], Desktop: [60_000, 250_000], Monitor: [18_000, 160_000], Mobile: [60_000, 120_000],
  Tablet: [45_000, 90_000], "Docking Station": [20_000, 40_000], Peripheral: [5_000, 25_000], Printer: [40_000, 300_000],
  Server: [800_000, 2_500_000], Switch: [150_000, 900_000], Router: [80_000, 400_000], Firewall: [150_000, 600_000],
  Storage: [900_000, 3_000_000], UPS: [150_000, 500_000], "Access Point": [30_000, 120_000], "VoIP Phone": [15_000, 40_000],
  "Conference Room Kit": [250_000, 600_000], Other: [8_000, 50_000],
};

const BUILTIN: [AssetStatus, number][] = [
  ["OPERATIONAL", 80], ["IN_STORAGE", 8], ["IN_MAINTENANCE", 4], ["RETIRED", 5], ["LOST", 1.2], ["UNKNOWN", 1.8],
];

const SITE_CODES: Record<string, string> = { "Buenos Aires HQ": "BUE", "Madrid Office": "MAD", "Austin Office": "AUS", "Colocation SP4": "SP4" };

export interface AssetPlan {
  index: number;
  serial: string;
  body: CreateAsset;
  owners: number[];
  previousOwner?: number;
  firstAssignedAt: string;
  archive: boolean;
}

function serialFor(rng: Rng, manufacturer: string): string {
  switch (manufacturer) {
    case "Apple":
      return `C02${rng.chars(9)}`;
    case "Dell":
      return rng.chars(7);
    case "Lenovo":
      return `PF${rng.chars(6)}`;
    case "HP":
    case "HPE":
      return `5CG${rng.chars(7)}`;
    default:
      return `${manufacturer.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase()}${rng.chars(10)}`;
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function planAssets(ctx: Ctx): AssetPlan[] {
  const modelsByCategory = new Map<string, { key: string; manufacturer: string }[]>();
  for (const [key, m] of sortedEntries(ctx.models)) {
    const list = modelsByCategory.get(m.category) ?? [];
    list.push({ key, manufacturer: key.split("|")[0]! });
    modelsByCategory.set(m.category, list);
  }
  const weights = CATEGORY_WEIGHTS.filter(([c]) => modelsByCategory.has(c));
  const paths = sortedEntries(ctx.locations);
  const racks = paths.filter(([, l]) => l.type === "RACK").map(([p]) => p);
  const rooms = paths.filter(([p]) => /\/Room [0-9.]+$/.test(p)).map(([p]) => p);
  const storage = paths.filter(([, l]) => l.type === "STORAGE").map(([p]) => p);
  const remote = paths.filter(([, l]) => l.type === "REMOTE").map(([p]) => p);
  const vendor = paths.filter(([, l]) => l.type === "OTHER").map(([p]) => p);
  const labels = STATUS_LABELS.filter((l) => ctx.labels.has(l.name));
  const userCount = ctx.users.length;
  const seen = new Set<string>();
  const plans: AssetPlan[] = [];

  for (let j = 0; j < ctx.volumes.assets; j++) {
    const rng = rngFor(ctx.seed, "asset", j);
    const category = rng.weighted(weights);
    const model = rng.pick(modelsByCategory.get(category)!);
    const seed = MODELS.find((m) => `${m.manufacturer}|${m.name}` === model.key);
    let serial = serialFor(rng, model.manufacturer);
    while (seen.has(serial)) serial = serialFor(rng, model.manufacturer);
    seen.add(serial);

    const retireAndArchive = j % 41 === 13;
    const label = j % 5 === 0 && labels.length > 0 ? labels[Math.floor(j / 5) % labels.length] : undefined;
    const kind: AssetStatus = label ? label.kind : retireAndArchive ? "RETIRED" : rng.weighted(BUILTIN);

    let locationPath: string | undefined;
    if (!END_USER.has(category) && !ROOM_GEAR.has(category)) locationPath = racks.length ? rng.pick(racks) : undefined;
    else if (label?.name === "At vendor repair" || (kind === "IN_MAINTENANCE" && rng.chance(0.3))) locationPath = vendor[0];
    else if (kind === "IN_STORAGE" || kind === "RETIRED") locationPath = storage.length ? rng.pick(storage) : undefined;
    else if (kind === "LOST" || kind === "UNKNOWN") locationPath = rng.chance(0.5) && rooms.length ? rng.pick(rooms) : undefined;
    else if (END_USER.has(category) && rng.chance(0.12)) locationPath = remote[0];
    else locationPath = rooms.length ? rng.pick(rooms) : undefined;
    const site = locationPath ? (SITE_CODES[locationPath.split("/")[0]!] ?? "RMT") : "UNK";

    const expiringSoon = j % 37 === 0;
    const ageDays = expiringSoon ? rng.int(1020, 1080) : rng.int(20, 1700);
    const purchaseDate = isoDaysAgo(ageDays);
    const warrantyMonths = expiringSoon ? 36 : rng.pick([12, 24, 36, 36, 36, 48]);
    const warrantyEnd = new Date(Date.parse(purchaseDate) + warrantyMonths * 30.4 * 86_400_000).toISOString();
    const [lo, hi] = PRICE_CENTS[category] ?? [10_000, 100_000];
    const cost = Math.round(rng.int(lo, hi) / 100) * 100;

    const specs: Record<string, unknown> = { ...(seed?.specs ?? {}) };
    if (category === "Laptop") {
      specs.encrypted = rng.chance(0.93);
      if (rng.chance(0.15) && typeof specs.ramGb === "number") specs.ramGb = (specs.ramGb as number) * 2;
    } else if (category === "Server" || category === "Desktop") {
      specs.hostname = `${site.toLowerCase()}-${NAME_PREFIX[category]!.toLowerCase()}-${String(j + 1).padStart(4, "0")}`;
    }

    const body: CreateAsset = {
      name: `${site}-${NAME_PREFIX[category] ?? "AST"}-${String(j + 1).padStart(4, "0")}`,
      serial,
      ...(label ? { statusLabelId: ctx.labels.get(label.name)!.id } : { status: kind }),
      specs,
      ...(rng.chance(0.08) ? { notes: rng.pick(["Battery replaced under warranty", "Has a cracked bezel, still usable", "Bought refurbished", "Keyboard swapped to ES layout", "Do not re-image: legal hold"]) } : {}),
      ...(rng.chance(0.95) ? { company: rng.weighted(COMPANIES.map((c, i) => [c, [80, 15, 5][i]!] as const)) } : {}),
      purchaseDate,
      warrantyEnd,
      purchaseCost: cost,
      purchaseCurrency: "USD",
      usefulLifeMonths: END_USER.has(category) ? 36 : 60,
      salvageValue: Math.round(cost * 0.1),
      modelId: ctx.models.get(model.key)!.id,
      ...(locationPath ? { locationId: ctx.locations.get(locationPath)!.id } : {}),
    };

    const owners: number[] = [];
    let assignChance = 0;
    if (category === "Conference Room Kit" && kind === "OPERATIONAL") assignChance = 0.5;
    else if (END_USER.has(category) && kind === "OPERATIONAL") assignChance = 0.97;
    else if (END_USER.has(category) && kind === "IN_MAINTENANCE") assignChance = 0.5;
    else if (!END_USER.has(category) && kind === "OPERATIONAL") assignChance = 0.15;
    if (userCount > 1 && rng.chance(assignChance)) {
      const ownerCount = category === "Conference Room Kit" ? rng.int(2, 3) : rng.chance(0.05) ? 2 : 1;
      while (owners.length < ownerCount) {
        const u = rng.int(0, userCount - 1);
        if (!owners.includes(u)) owners.push(u);
      }
    }
    let previousOwner: number | undefined;
    if (owners.length > 0 && rng.chance(0.12)) {
      const u = rng.int(0, userCount - 1);
      if (!owners.includes(u)) previousOwner = u;
    }
    plans.push({
      index: j,
      serial,
      body,
      owners,
      previousOwner,
      firstAssignedAt: isoDaysAgo(Math.max(1, ageDays - rng.int(1, 15))),
      archive: kind === "RETIRED" && owners.length === 0 && (retireAndArchive || rng.chance(0.4)),
    });
  }
  return plans;
}

export async function runAssets(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const plans = planAssets(ctx);
  const [live, archived, assignments] = await Promise.all([
    api.all<AssetListItem>("/assets", { sort: "serial" }),
    api.all<AssetListItem>("/assets", { deleted: "only", sort: "serial" }),
    api.get<AssetAssignment[]>("/asset-assignments", { activeOnly: false }),
  ]);
  const bySerial = new Map<string, { id: string; deleted: boolean }>();
  for (const a of live) if (a.serial) bySerial.set(a.serial, { id: a.id, deleted: false });
  for (const a of archived) if (a.serial && !bySerial.has(a.serial)) bySerial.set(a.serial, { id: a.id, deleted: true });
  const assigned = new Set(assignments.map((a) => a.assetId));
  const progress = report.progress("assets", plans.length);

  const assign = async (assetId: string, userIndex: number, assignedAt?: string): Promise<AssetAssignment | undefined> => {
    const userId = ctx.users[userIndex]?.id;
    if (!userId) return undefined;
    const body: CreateAssetAssignment = { assetId, userId, ...(assignedAt ? { assignedAt } : {}) };
    try {
      const created = await api.post<AssetAssignment>("/asset-assignments", body);
      report.created("asset assignment");
      return created;
    } catch (err) {
      report.failed("asset assignment", `${assetId} -> ${userIndex}`, err);
      return undefined;
    }
  };

  await pool(plans, ctx.concurrency, async (plan) => {
    progress.tick();
    let existing = bySerial.get(plan.serial);
    if (existing) {
      report.skipped("asset");
    } else {
      try {
        const created = await api.post<Asset>("/assets", plan.body);
        existing = { id: created.id, deleted: false };
        report.created("asset");
      } catch (err) {
        report.failed("asset", plan.serial, err);
        return;
      }
    }
    if (existing.deleted) {
      if (plan.archive) report.skipped("asset archive");
      return;
    }
    if (!plan.archive) ctx.assets.set(plan.index, existing.id);

    if (plan.owners.length > 0) {
      if (assigned.has(existing.id)) {
        report.skipped("asset assignment");
      } else {
        if (plan.previousOwner !== undefined) {
          const previous = await assign(existing.id, plan.previousOwner, plan.firstAssignedAt);
          if (previous) {
            try {
              await api.patch(`/asset-assignments/${previous.id}/release`, { notes: "Device handed over to a new owner" });
              report.created("asset check-in");
            } catch (err) {
              report.failed("asset check-in", previous.id, err);
            }
          }
          for (const owner of plan.owners) await assign(existing.id, owner);
        } else {
          for (const owner of plan.owners) await assign(existing.id, owner, plan.firstAssignedAt);
        }
      }
    }

    if (plan.archive) {
      try {
        await api.delete(`/assets/${existing.id}`);
        report.created("asset archive");
      } catch (err) {
        report.failed("asset archive", plan.serial, err);
      }
    }
  });
}

export const ASSET_ENTITIES = ["asset", "asset assignment", "asset check-in", "asset archive"];
