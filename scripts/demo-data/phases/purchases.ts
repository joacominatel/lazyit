import type {
  ApplyLicense,
  CancelRemainingUnits,
  CreatePurchaseOrder,
  CreatePurchaseOrderLine,
  PurchaseOrderDetail,
  PurchaseOrderListItem,
  PurchaseOrderStatus,
  ReceiveFromLine,
  ReceiveStockFromLine,
} from "@lazyit/shared";
import { pool } from "../lib/api";
import { type Ctx, sortedEntries } from "../lib/context";
import { type Rng, rngFor, seedCode } from "../lib/rng";
import { ARCHIVED_SUPPLIERS, COMPANIES, CONSUMABLES } from "../lib/words";

// One scenario per receipt / lifecycle state, cycled so even a dozen purchases cover them all.
const SCENARIOS = [
  "draft",
  "ordered-pending",
  "partial",
  "received",
  "over-received",
  "cancelled",
  "cancel-remaining",
  "license",
  "archived",
  "services",
  "consumables-pending",
] as const;
type Scenario = (typeof SCENARIOS)[number];

type Receipt =
  | { kind: "assets"; line: number; quantity: number }
  | { kind: "stock"; line: number; quantity: number }
  | { kind: "cancel"; line: number }
  | { kind: "license"; line: number; renew: boolean };

interface PurchasePlan {
  reference: string;
  scenario: Scenario;
  body: CreatePurchaseOrder;
  receipts: Receipt[];
  archive: boolean;
}

const OTHER_LINES = ["On-site installation", "Shipping and handling", "Extended support (3 years)", "Cabling labour", "Data destruction certificate"];

function assetLine(ctx: Ctx, rng: Rng, min: number, max: number): CreatePurchaseOrderLine {
  const [key] = rng.pick(sortedEntries(ctx.models));
  const [manufacturer, model] = key.split("|") as [string, string];
  return {
    kind: "ASSET",
    description: `${manufacturer} ${model}`,
    manufacturerText: manufacturer,
    modelText: model,
    assetModelId: ctx.models.get(key)!.id,
    quantity: rng.int(min, max),
    unitPrice: rng.int(200, 2500) * 100,
    warrantyMonths: rng.pick([12, 24, 36]),
  };
}

function consumableLine(ctx: Ctx, rng: Rng): CreatePurchaseOrderLine | undefined {
  const options = CONSUMABLES.filter((c) => ctx.consumables.has(c.sku));
  if (options.length === 0) return undefined;
  const c = rng.pick(options);
  return { kind: "CONSUMABLE", description: c.name, consumableId: ctx.consumables.get(c.sku)!, quantity: rng.int(2, 12) * 10 + rng.int(1, 9), unitPrice: rng.int(3, 90) * 100 };
}

function planPurchases(ctx: Ctx): PurchasePlan[] {
  const suppliers = sortedEntries(ctx.suppliers).filter(([name]) => !(ARCHIVED_SUPPLIERS as readonly string[]).includes(name));
  const deliveries = sortedEntries(ctx.locations).filter(([, l]) => l.type === "STORAGE").map(([, l]) => l.id);
  const apps = sortedEntries(ctx.applications).map(([, id]) => id);
  const code = seedCode(ctx.seed);
  const plans: PurchasePlan[] = [];
  for (let p = 0; p < ctx.volumes.purchases; p++) {
    const rng = rngFor(ctx.seed, "purchase", p);
    const scenario = SCENARIOS[p % SCENARIOS.length]!;
    const lines: CreatePurchaseOrderLine[] = [];
    const receipts: Receipt[] = [];
    let status: PurchaseOrderStatus = "ORDERED";
    const addConsumable = () => {
      const line = consumableLine(ctx, rng);
      if (line) lines.push(line);
      return line ? lines.length - 1 : -1;
    };
    switch (scenario) {
      case "draft":
      case "archived":
        status = "DRAFT";
        lines.push(assetLine(ctx, rng, 1, 6));
        addConsumable();
        break;
      case "ordered-pending":
        lines.push(assetLine(ctx, rng, 2, 10));
        if (apps.length) lines.push({ kind: "LICENSE", description: "Annual subscription seats", applicationId: rng.pick(apps), quantity: rng.int(5, 60), unitPrice: rng.int(5, 40) * 100 });
        break;
      case "partial": {
        lines.push(assetLine(ctx, rng, 4, 12));
        receipts.push({ kind: "assets", line: 0, quantity: Math.floor((lines[0]!.quantity ?? 1) / 2) });
        const c = addConsumable();
        if (c >= 0) receipts.push({ kind: "stock", line: c, quantity: Math.floor((lines[c]!.quantity ?? 1) / 3) });
        break;
      }
      case "received": {
        lines.push(assetLine(ctx, rng, 1, 5));
        receipts.push({ kind: "assets", line: 0, quantity: lines[0]!.quantity ?? 1 });
        const c = addConsumable();
        if (c >= 0) receipts.push({ kind: "stock", line: c, quantity: lines[c]!.quantity ?? 1 });
        break;
      }
      case "over-received": {
        const c = addConsumable();
        if (c >= 0) receipts.push({ kind: "stock", line: c, quantity: (lines[c]!.quantity ?? 1) + rng.int(1, 9) });
        else lines.push(assetLine(ctx, rng, 1, 3));
        break;
      }
      case "cancelled":
        status = "CANCELLED";
        lines.push(assetLine(ctx, rng, 2, 8));
        break;
      case "cancel-remaining":
        lines.push(assetLine(ctx, rng, 5, 9));
        receipts.push({ kind: "assets", line: 0, quantity: 3 }, { kind: "cancel", line: 0 });
        break;
      case "license":
        if (apps.length) {
          lines.push({ kind: "LICENSE", description: "Seat expansion", applicationId: rng.pick(apps), quantity: rng.int(5, 80), unitPrice: rng.int(5, 40) * 100 });
          receipts.push({ kind: "license", line: 0, renew: rng.chance(0.5) });
        } else {
          lines.push(assetLine(ctx, rng, 1, 3));
        }
        break;
      case "services":
        for (const description of rng.sample(OTHER_LINES, rng.int(1, 3))) {
          lines.push({ kind: "OTHER", description, quantity: 1, unitPrice: rng.int(150, 4000) * 100 });
        }
        break;
      case "consumables-pending":
        addConsumable();
        addConsumable();
        break;
    }
    if (lines.length === 0) lines.push({ kind: "OTHER", description: rng.pick(OTHER_LINES), quantity: 1, unitPrice: 50_000 });
    const orderDays = rng.int(3, 400);
    const ordered = new Date(Date.now() - orderDays * 86_400_000);
    const reference = `PO-${code}-${String(p + 1).padStart(4, "0")}`;
    const invoiced = status === "ORDERED" && rng.chance(0.5);
    plans.push({
      reference,
      scenario,
      archive: scenario === "archived",
      receipts,
      body: {
        reference,
        status,
        currency: rng.chance(0.85) ? "USD" : "EUR",
        ...(suppliers.length ? { supplierId: rng.pick(suppliers)[1] } : {}),
        ...(status !== "DRAFT" ? { orderDate: ordered.toISOString() } : {}),
        expectedDate: new Date(ordered.getTime() + rng.int(5, 45) * 86_400_000).toISOString(),
        ...(deliveries.length ? { deliveryLocationId: rng.pick(deliveries) } : {}),
        company: rng.pick(COMPANIES),
        ...(invoiced ? { invoiceNumbers: `INV-${rng.int(10000, 99999)}`, invoiceDate: new Date(ordered.getTime() + 86_400_000).toISOString() } : {}),
        ...(rng.chance(0.3) ? { notes: rng.pick(["Quote attached in the shared drive", "Split delivery agreed with the vendor", "Approved by finance, budget line IT-OPEX"]) } : {}),
        lines,
      },
    });
  }
  return plans;
}

export async function runPurchases(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const plans = planPurchases(ctx);
  const [live, archived] = await Promise.all([
    api.all<PurchaseOrderListItem>("/purchase-orders", { sort: "reference" }),
    api.all<PurchaseOrderListItem>("/purchase-orders", { deleted: "only", sort: "reference" }),
  ]);
  const references = new Set([...live, ...archived].map((p) => p.reference));
  const progress = report.progress("purchases", plans.length);
  await pool(plans, ctx.concurrency, async (plan, index) => {
    progress.tick();
    if (references.has(plan.reference)) {
      report.skipped("purchase");
      return;
    }
    let po: PurchaseOrderDetail;
    try {
      po = await api.post<PurchaseOrderDetail>("/purchase-orders", plan.body);
      report.created("purchase");
    } catch (err) {
      report.failed("purchase", plan.reference, err);
      return;
    }
    const lineIds = [...po.lines].sort((a, b) => a.position - b.position).map((l) => l.id);
    const rng = rngFor(ctx.seed, "receipt", index);
    for (const receipt of plan.receipts) {
      const lineId = lineIds[receipt.line];
      if (!lineId) continue;
      const base = `/purchase-orders/${po.id}/lines/${lineId}`;
      try {
        if (receipt.kind === "assets" && receipt.quantity > 0) {
          const body: ReceiveFromLine = {
            quantity: receipt.quantity,
            serials: Array.from({ length: receipt.quantity }, () => `RCV${rng.chars(9)}`),
            ...(rng.chance(0.5) && ctx.labels.has("Ready to deploy") ? { statusLabelId: ctx.labels.get("Ready to deploy")!.id } : { status: "IN_STORAGE" as const }),
          };
          await api.post(`${base}/receive`, body);
        } else if (receipt.kind === "stock" && receipt.quantity > 0) {
          const body: ReceiveStockFromLine = { quantity: receipt.quantity, note: "Counted at the loading dock" };
          await api.post(`${base}/receive-stock`, body);
        } else if (receipt.kind === "cancel") {
          const body: CancelRemainingUnits = { reason: "Vendor discontinued the model; remaining units cancelled" };
          await api.post(`${base}/cancel-remaining`, body);
        } else if (receipt.kind === "license") {
          const line = po.lines.find((l) => l.id === lineId);
          const body: ApplyLicense = {
            seatsToAdd: line?.quantity ?? 1,
            ...(receipt.renew ? { renewalDate: new Date(Date.now() + 365 * 86_400_000).toISOString() } : {}),
          };
          await api.post(`${base}/apply-license`, body);
        } else {
          continue;
        }
        report.created("purchase receipt");
      } catch (err) {
        report.failed("purchase receipt", `${plan.reference} ${receipt.kind}`, err);
      }
    }
    if (plan.archive) {
      try {
        await api.delete(`/purchase-orders/${po.id}`);
        report.created("purchase archive");
      } catch (err) {
        report.failed("purchase archive", plan.reference, err);
      }
    }
  });
}

export const PURCHASE_ENTITIES = ["purchase", "purchase receipt", "purchase archive"];
