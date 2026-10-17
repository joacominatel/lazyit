import { afterAll, describe, expect, mock, test } from "bun:test";

const calls: string[] = [];

// `mock.module` is process-wide: hand the real client back when this file is done (see infra.test.ts).
const CLIENT = Bun.resolveSync("../client", import.meta.dir);
const realClient = { ...(await import("../client")) };
afterAll(() => mock.module(CLIENT, () => realClient));
void mock.module(CLIENT, () => ({
  ...realClient,
  apiFetch: (path: string) => {
    calls.push(path);
    return Promise.resolve({ items: [], total: 0, limit: 50, offset: 0 });
  },
}));

const { assetFilterParams, getAssets } = await import("./assets");
const { activityFilterParams, getDashboardActivity } = await import("./dashboard");
const { auditLogFilterParams, getAuditLogs } = await import("./audit");
const { getUserGrants, getUsers, userFilterParams } = await import("./users");
const { deriveUserParams } = await import("@/app/(app)/users/_components/users-list-query");
const { accessGrantFilterParams, getAccessGrants } = await import("./access-grants");
const { applicationGrantFilterParams, getApplicationGrants } = await import("./applications");
const { consumableFilterParams, getConsumables } = await import("./consumables");
const { getPendingLines, getPurchaseOrders, pendingLineFilterParams, purchaseOrderFilterParams } =
  await import("./purchase-orders");
const { applicationFilterParams, getApplications } = await import("./applications");
const { getLocations, locationFilterParams } = await import("./locations");
const { getSuppliers, supplierFilterParams } = await import("./suppliers");
const { accessRequestFilterParams, getAccessRequests } = await import("./access-requests");
const { getInfraNodes, infraNodeFilterParams } = await import("./infra");
const {
  consumableDeliveryFilterParams,
  consumableMovementFilterParams,
  getConsumableDeliveries,
  getConsumableMovements,
} = await import("./consumables");
const { articleFilterParams, getArticles } = await import("./articles");

const WINDOW_KEYS = ["limit", "offset", "sort", "dir"];
const CUID = "ck0000000000000000000000a1";
const UUID = "00000000-0000-4000-8000-000000000001";

/** The list request's filters: its query string without the page window and sort. */
async function listFilters(call: () => Promise<unknown>): Promise<string[][]> {
  calls.length = 0;
  await call();
  const params = new URL(calls[0], "http://x").searchParams;
  for (const key of WINDOW_KEYS) params.delete(key);
  return [...params.entries()].sort();
}

function entries(params: URLSearchParams): string[][] {
  return [...params.entries()].sort();
}

/** The export sends what the list sends, minus paging and sort, and that is never nothing. */
async function expectSameFilters(
  call: () => Promise<unknown>,
  exportParams: URLSearchParams,
  minFilters = 2,
) {
  const exported = entries(exportParams);
  expect(exported.length).toBeGreaterThanOrEqual(minFilters);
  expect(exported.map(([key]) => key)).not.toContainAnyValues(WINDOW_KEYS);
  expect(await listFilters(call)).toEqual(exported);
}

const window = { sort: "createdAt", dir: "asc" as const, limit: 25, offset: 50 };

describe("each list and its CSV export send identical filter params (ADR-0103)", () => {
  test("assets, purchase filters included", async () => {
    const filters = {
      q: "dell",
      categoryId: CUID,
      modelId: CUID,
      locationId: CUID,
      status: "IN_STORAGE" as const,
      statusLabelId: CUID,
      company: "Acme",
      assignedToUserId: UUID,
      ownership: "HAS" as const,
      warranty: "expired" as const,
      deleted: "only" as const,
      purchase: { purchaseOrderId: CUID, purchaseLinked: false },
    };
    await expectSameFilters(() => getAssets({ ...filters, ...window }), assetFilterParams(filters));
    expect(assetFilterParams(filters).get("purchaseLinked")).toBe("false");
  });

  test("Reports › activity", async () => {
    const filters = {
      entityType: "asset" as const,
      entityId: CUID,
      actorId: "me" as const,
      action: "assigned" as const,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-16T00:00:00.000Z",
      q: "laptop",
    };
    await expectSameFilters(
      () => getDashboardActivity({ ...filters, limit: 25, offset: 50 }),
      activityFilterParams(filters),
    );
  });

  test("Reports › audit, the source included", async () => {
    const filters = {
      action: "USERS",
      actorId: UUID,
      serviceAccountId: CUID,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-16T00:00:00.000Z",
    };
    await expectSameFilters(
      () => getAuditLogs({ source: "export", ...filters, limit: 25, offset: 50 }),
      auditLogFilterParams("export", filters),
    );
    expect(auditLogFilterParams("export", filters).get("source")).toBe("export");
  });

  test("users, the Active / Inactive status included", async () => {
    const filters = {
      q: "ana",
      role: "MEMBER" as const,
      directoryOnly: false,
      deleted: "only" as const,
      isActive: false,
    };
    await expectSameFilters(() => getUsers({ ...filters, ...window }), userFilterParams(filters));
  });

  test("users: the status filter reaches the list request as isActive", async () => {
    const state = { q: "", sort: "createdAt", dir: "desc" as const, offset: 0, limit: 50 };
    const derive = (status: string) =>
      deriveUserParams(
        { ...state, filters: { status, archived: "ALL", directory: "ALL", role: "ALL" } },
        { isAdmin: false },
      );
    const inactive = derive("INACTIVE");
    expect(await listFilters(() => getUsers(inactive))).toEqual([["isActive", "false"]]);
    expect(entries(userFilterParams(inactive))).toEqual([["isActive", "false"]]);
    expect(derive("ACTIVE").isActive).toBe(true);
    expect(derive("ALL").isActive).toBeUndefined();
  });

  test("access grants, global and per user", async () => {
    const filters = { userId: UUID, applicationId: CUID, activeOnly: false, includeExpired: false };
    await expectSameFilters(
      () => getAccessGrants({ ...filters, limit: 25, offset: 50 }),
      accessGrantFilterParams(filters),
    );
  });

  test("a person's grants: the person page's list and its export (the export names the user)", async () => {
    const exported = accessGrantFilterParams({ userId: UUID, activeOnly: false });
    expect(exported.get("userId")).toBe(UUID);
    exported.delete("userId");
    calls.length = 0;
    await getUserGrants(UUID, false);
    expect(calls[0]).toStartWith(`/users/${UUID}/access-grants?`);
    expect(await listFilters(() => getUserGrants(UUID, false))).toEqual(entries(exported));
  });

  test("access grants of one application", async () => {
    const options = { activeOnly: false, includeExpired: false };
    await expectSameFilters(
      () => getApplicationGrants(CUID, options),
      applicationGrantFilterParams(options),
    );
  });

  test("consumables", async () => {
    const filters = { q: "toner", lowStock: true, category: CUID, deleted: "only" as const };
    await expectSameFilters(
      () => getConsumables({ ...filters, ...window }),
      consumableFilterParams(filters),
    );
  });

  test("purchases", async () => {
    const filters = {
      q: "INV-1",
      status: ["DRAFT" as const, "ORDERED" as const],
      supplierId: CUID,
      receipt: "PENDING" as const,
      deleted: "only" as const,
    };
    await expectSameFilters(
      () => getPurchaseOrders({ ...filters, ...window }),
      purchaseOrderFilterParams(filters),
    );
  });
});

describe("phase 2: each list and its CSV export send identical filter params (ADR-0103)", () => {
  test("applications", async () => {
    const filters = { q: "jira", deleted: "only" as const };
    await expectSameFilters(
      () => getApplications({ ...filters, ...window }),
      applicationFilterParams(filters),
    );
  });

  test("locations", async () => {
    const filters = { q: "colo", type: "DATACENTER" as const, deleted: "only" as const };
    await expectSameFilters(
      () => getLocations({ ...filters, ...window }),
      locationFilterParams(filters),
    );
  });

  test("suppliers", async () => {
    const filters = { q: "dell", deleted: "only" as const };
    await expectSameFilters(
      () => getSuppliers({ ...filters, ...window }),
      supplierFilterParams(filters),
    );
  });

  test("pending units, whose only filter is the supplier", async () => {
    await expectSameFilters(
      () => getPendingLines({ supplierId: CUID, limit: 25, offset: 50 }),
      pendingLineFilterParams({ supplierId: CUID }),
      1,
    );
  });

  test("access requests (the managers' list)", async () => {
    const filters = { status: "PENDING" as const, applicationId: CUID, requesterId: UUID };
    await expectSameFilters(
      () => getAccessRequests({ ...filters, limit: 25, offset: 50 }),
      accessRequestFilterParams(filters),
    );
  });

  test("servers", async () => {
    const filters = {
      kind: "VM" as const,
      status: "ONLINE" as const,
      state: "CONFIRMED" as const,
      source: "AGENT" as const,
      role: "HOST" as const,
      ids: [CUID],
      assetIds: [CUID],
      q: "web",
    };
    await expectSameFilters(
      () => getInfraNodes({ ...filters, ...window }),
      infraNodeFilterParams(filters),
    );
  });

  test("a consumable's movements", async () => {
    const query = {
      type: "OUT" as const,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-16T00:00:00.000Z",
    };
    await expectSameFilters(
      () => getConsumableMovements(CUID, query),
      consumableMovementFilterParams(query),
    );
  });

  test("the deliveries to one target", async () => {
    const params = {
      targetUserId: UUID,
      outstandingOnly: true,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-16T00:00:00.000Z",
    };
    await expectSameFilters(
      () => getConsumableDeliveries({ ...params, limit: 25, offset: 50 }),
      consumableDeliveryFilterParams(params),
    );
  });

  test("the KB article index", async () => {
    const filters = {
      categoryId: [CUID],
      includeSubfolders: true,
      authorId: UUID,
      status: ["DRAFT" as const, "PUBLISHED" as const],
      q: "vpn",
      linked: "only" as const,
      linkedTo: ["asset" as const],
      assetId: [CUID],
      applicationId: [CUID],
    };
    await expectSameFilters(
      () => getArticles({ ...filters, sort: "title", limit: 25, offset: 50 }),
      articleFilterParams(filters),
    );
  });
});
