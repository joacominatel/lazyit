import type { Consumable, ConsumableMovement, CreateConsumable, CreateConsumableMovement } from "@lazyit/shared";
import { pool } from "../lib/api";
import { type Ctx, sortedEntries } from "../lib/context";
import { type Rng, rngFor } from "../lib/rng";
import { ARCHIVED_CONSUMABLE_SKU, CONSUMABLE_CATEGORY_RENAMES, CONSUMABLES } from "../lib/words";
import { categoryId } from "./taxonomy";

type Step = CreateConsumableMovement & { returnsPrevious?: boolean };

function pickTarget(ctx: Ctx, rng: Rng): Partial<CreateConsumableMovement> {
  const roll = rng.next();
  if (roll < 0.5) {
    const user = ctx.users[rng.int(0, Math.max(0, ctx.users.length - 1))];
    return user?.id ? { targetUserId: user.id } : {};
  }
  if (roll < 0.65 && ctx.assets.size > 0) {
    return { targetAssetId: rng.pick(sortedEntries(ctx.assets))[1] };
  }
  if (roll < 0.8) {
    const rooms = sortedEntries(ctx.locations).filter(([p]) => /\/Room /.test(p));
    return rooms.length ? { targetLocationId: rng.pick(rooms)[1].id } : {};
  }
  return {};
}

function planMovements(ctx: Ctx, index: number, minStock: number, returnable: boolean): Step[] {
  const rng = rngFor(ctx.seed, "consumable", index);
  const low = index % 5 === 2;
  const empty = index % 13 === 9;
  const steps: Step[] = [];
  let stock = minStock * rng.int(2, 5) + rng.int(1, 9);
  steps.push({ type: "IN", quantity: stock, reason: "Initial stock count" });
  const outs = rng.int(3, 9);
  for (let k = 0; k < outs && stock > 1; k++) {
    const quantity = Math.min(stock - 1, rng.int(1, Math.max(1, Math.round(minStock / 3))));
    const target = pickTarget(ctx, rng);
    steps.push({ type: "OUT", quantity, reason: target.targetUserId ? "Issued to user" : rng.pick(["Desk setup", "Replacement", "Room refresh", "Project kit"]), ...target });
    stock -= quantity;
    if (returnable && target.targetUserId && rng.chance(0.5)) {
      steps.push({ type: "IN", quantity: 1, reason: "Returned by user", returnsPrevious: true });
      stock += 1;
    }
    if (rng.chance(0.2)) {
      const quantity = minStock * rng.int(1, 2) + rng.int(1, 9);
      steps.push({ type: "IN", quantity, reason: "Restock from supplier" });
      stock += quantity;
    }
  }
  if (rng.chance(0.45)) {
    const counted = Math.max(1, stock - rng.int(0, 3));
    steps.push({ type: "ADJUSTMENT", quantity: counted, reason: "Quarterly physical count", notes: "Counted by the IT desk" });
    stock = counted;
  }
  const floor = empty ? 0 : low ? rng.int(0, Math.max(0, minStock - 1)) : -1;
  if (floor >= 0 && stock > floor) steps.push({ type: "OUT", quantity: stock - floor, reason: "Bulk issue for onboarding wave" });
  return steps;
}

export async function runConsumables(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const [live, archived] = await Promise.all([
    api.all<Consumable>("/consumables", { sort: "sku" }),
    api.all<Consumable>("/consumables", { deleted: "only", sort: "sku" }),
  ]);
  const bySku = new Map([...archived, ...live].filter((c) => c.sku).map((c) => [c.sku!, c]));
  await pool(CONSUMABLES.slice(0, ctx.taxa.consumables), ctx.concurrency, async (seed, index) => {
    let consumable = bySku.get(seed.sku);
    let fresh = false;
    if (consumable) {
      report.skipped("consumable");
    } else {
      const category = categoryId(ctx.consumableCategories, seed.category, CONSUMABLE_CATEGORY_RENAMES);
      const body: CreateConsumable = {
        name: seed.name,
        sku: seed.sku,
        unit: seed.unit,
        minStock: seed.minStock,
        ...(category ? { categoryId: category } : {}),
        ...("returnable" in seed ? { returnable: true } : {}),
        ...(index % 4 === 1 ? { description: `Standard ${seed.name.toLowerCase()} kept at every IT desk` } : {}),
      };
      try {
        consumable = await api.post<Consumable>("/consumables", body);
        fresh = true;
        report.created("consumable");
      } catch (err) {
        report.failed("consumable", seed.sku, err);
        return;
      }
    }
    if (consumable.deletedAt) {
      report.skipped("consumable archive");
      return;
    }
    ctx.consumables.set(seed.sku, consumable.id);

    const hasMovements = fresh ? false : (await api.get<ConsumableMovement[]>(`/consumables/${consumable.id}/movements`)).length > 0;
    const steps = planMovements(ctx, index, seed.minStock, "returnable" in seed);
    if (hasMovements) {
      report.skipped("consumable movement", steps.length);
    } else {
      let lastDelivery: number | undefined;
      for (const { returnsPrevious, ...step } of steps) {
        if (returnsPrevious && lastDelivery === undefined) continue;
        const body: CreateConsumableMovement = returnsPrevious ? { ...step, returnOfId: lastDelivery } : step;
        try {
          const movement = await api.post<ConsumableMovement>(`/consumables/${consumable.id}/movements`, body);
          if (movement.type === "OUT" && movement.targetUserId) lastDelivery = movement.id;
          report.created("consumable movement");
        } catch (err) {
          report.failed("consumable movement", `${seed.sku} ${step.type} ${step.quantity}`, err);
        }
      }
    }

    if (seed.sku === ARCHIVED_CONSUMABLE_SKU) {
      try {
        await api.delete(`/consumables/${consumable.id}`);
        ctx.consumables.delete(seed.sku);
        report.created("consumable archive");
      } catch (err) {
        report.failed("consumable archive", seed.sku, err);
      }
    }
  });
}

export const CONSUMABLE_ENTITIES = ["consumable", "consumable movement", "consumable archive"];
