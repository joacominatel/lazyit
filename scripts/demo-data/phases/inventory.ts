import type { ArticleCategory, AssetStatusLabel, Consumable, ConsumableMovement, RoleCounts } from "@lazyit/shared";
import type { Client } from "../lib/api";

const ASSET_STATUSES = ["OPERATIONAL", "IN_MAINTENANCE", "IN_STORAGE", "RETIRED", "LOST", "UNKNOWN"];

function line(label: string, values: Record<string, number | string>): void {
  console.log(`   ${label.padEnd(22)} ${Object.entries(values).map(([k, v]) => `${k} ${v}`).join("  ")}`);
}

export async function printInventory(api: Client): Promise<void> {
  console.log("\n== Inventory (read back from the API)");
  const roles = await api.get<RoleCounts>("/users/role-counts");
  line("users by role", { ...roles });
  line("users by state", {
    active: await api.total("/users", { isActive: "true" }),
    deactivated: await api.total("/users", { isActive: "false" }),
    offboarded: await api.total("/users", { deleted: "only" }),
  });

  const byStatus: Record<string, number> = {};
  for (const status of ASSET_STATUSES) byStatus[status] = await api.total("/assets", { status });
  line("assets by status", byStatus);
  const labels = await api.get<AssetStatusLabel[]>("/asset-status-labels");
  line("assets by custom label", Object.fromEntries(labels.map((l) => [l.name.replace(/ /g, "_"), l.assetCount ?? 0])));
  line("assets", {
    assigned: await api.total("/assets", { ownership: "HAS" }),
    unassigned: await api.total("/assets", { ownership: "NONE" }),
    archived: await api.total("/assets", { deleted: "only" }),
    warranty_expiring: await api.total("/assets", { warranty: "expiring90d" }),
    warranty_expired: await api.total("/assets", { warranty: "expired" }),
  });

  const allGrants = await api.total("/access-grants", { activeOnly: false, includeExpired: true });
  const activeGrants = await api.total("/access-grants");
  line("access grants", { active: activeGrants, revoked_or_expired: allGrants - activeGrants });
  line("access requests", {
    PENDING: await api.total("/access-requests", { status: "PENDING" }),
    APPROVED: await api.total("/access-requests", { status: "APPROVED" }),
    DENIED: await api.total("/access-requests", { status: "DENIED" }),
  });

  const purchases: Record<string, number> = {};
  for (const status of ["DRAFT", "ORDERED", "CANCELLED"]) purchases[status] = await api.total("/purchase-orders", { status });
  for (const receipt of ["PENDING", "NONE", "PARTIAL", "RECEIVED", "OVER"]) purchases[`receipt_${receipt}`] = await api.total("/purchase-orders", { receipt });
  purchases.archived = await api.total("/purchase-orders", { deleted: "only" });
  line("purchases", purchases);

  const consumables = await api.all<Consumable>("/consumables", { sort: "sku" });
  const movements: Record<string, number> = { IN: 0, OUT: 0, ADJUSTMENT: 0 };
  for (const c of consumables) {
    for (const m of await api.get<ConsumableMovement[]>(`/consumables/${c.id}/movements`)) movements[m.type] = (movements[m.type] ?? 0) + 1;
  }
  line("consumables", {
    live: consumables.length,
    below_min: consumables.filter((c) => c.minStock !== null && c.currentStock < c.minStock).length,
    out_of_stock: consumables.filter((c) => c.currentStock === 0).length,
    archived: await api.total("/consumables", { deleted: "only" }),
  });
  line("consumable movements", movements);

  const folders = await api.get<(ArticleCategory & { accessRules?: unknown[] | null })[]>("/article-categories");
  const byId = new Map(folders.map((f) => [f.id, f]));
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let cur = byId.get(id); cur && depth < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined) depth++;
    return depth;
  };
  const perDepth = new Map<number, { folders: number; PUBLISHED: number; DRAFT: number }>();
  for (const f of folders) {
    const d = depthOf(f.id);
    const row = perDepth.get(d) ?? { folders: 0, PUBLISHED: 0, DRAFT: 0 };
    row.folders++;
    row.PUBLISHED += await api.total("/articles", { categoryId: f.id, status: "PUBLISHED" });
    row.DRAFT += await api.total("/articles", { categoryId: f.id, status: "DRAFT" });
    perDepth.set(d, row);
  }
  for (const [d, row] of [...perDepth].sort(([a], [b]) => a - b)) line(`kb depth ${d}`, row);
  line("kb folders", {
    total: folders.length,
    restricted: folders.filter((f) => f.hasAccessRules || (f.accessRules?.length ?? 0) > 0).length,
  });
}
