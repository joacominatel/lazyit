import { describe, expect, it } from "bun:test";
import type {
  Application,
  AssetListItem,
  AssetModel,
  Location,
  UserListItem,
} from "@lazyit/shared";
import {
  detailHref,
  formatOwners,
  type QuickViewData,
  type QuickViewLabels,
  selectFields,
  titleFor,
} from "./quick-view-fields";

/**
 * Unit tests for the PURE Quick View presenter (ADR-0072). The component rendering is not e2e'd
 * (frontend e2e is deferred, ADR-0012); this locks the load-bearing field selection: per-entity
 * order, empty-value dropping, the SEC-008 url gate, the no-detail-route entities, and the asset
 * owner formatting (the CEO's headline disambiguator).
 */

const NOW = "2026-06-24T00:00:00.000Z";

/** Stand-in for the localized `common.quickView.*` strings the asset owner field needs. */
const LABELS: QuickViewLabels = {
  noOwner: "Unassigned",
  moreOwners: (count) => `+${count} more`,
};

/** Build an `AssetListItem.activeAssignments` entry for `firstName lastName`. */
function makeAssignment(
  firstName: string,
  lastName: string,
): AssetListItem["activeAssignments"][number] {
  return {
    id: `assign_${firstName}`,
    userId: "11111111-1111-1111-1111-111111111111",
    user: {
      id: "11111111-1111-1111-1111-111111111111",
      firstName,
      lastName,
      email: `${firstName}@example.com`.toLowerCase(),
      deletedAt: null,
    },
  };
}

function makeAsset(overrides: Partial<AssetListItem> = {}): AssetListItem {
  return {
    id: "asset_1",
    name: "MacBook Pro",
    serial: "C02XYZ",
    assetTag: "LZ-0001",
    status: "OPERATIONAL",
    notes: null,
    purchaseDate: null,
    warrantyEnd: null,
    modelId: "model_1",
    locationId: "loc_1",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    model: {
      id: "model_1",
      name: "Latitude 5520",
      manufacturer: "Dell",
      category: { id: "cat_1", name: "Laptops" },
    },
    location: { id: "loc_1", name: "HQ Madrid", type: "OFFICE" },
    activeAssignments: [],
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    id: "user_1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    isActive: true,
    role: "MEMBER",
    externalId: null,
    legajo: "12345",
    username: "ada",
    manager: null,
    directoryOnly: false,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

describe("titleFor", () => {
  it("builds a user title from first + last name", () => {
    expect(titleFor({ entity: "user", data: makeUser() })).toBe("Ada Lovelace");
  });

  it("builds an asset-model title as manufacturer + name", () => {
    const model: AssetModel = {
      id: "m1",
      name: "Latitude 5520",
      manufacturer: "Dell",
      sku: null,
      description: null,
      specs: null,
      categoryId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    expect(titleFor({ entity: "assetModel", data: model })).toBe(
      "Dell Latitude 5520",
    );
  });

  it("uses the entity name for the default case", () => {
    expect(titleFor({ entity: "asset", data: makeAsset() })).toBe("MacBook Pro");
  });
});

describe("selectFields — asset", () => {
  it("emits serial, assetTag, model, category, location, owner in order", () => {
    const fields = selectFields({ entity: "asset", data: makeAsset() }, LABELS);
    expect(fields.map((f) => f.labelKey)).toEqual([
      "serial",
      "assetTag",
      "model",
      "category",
      "location",
      "owner",
    ]);
    expect(fields[0]).toMatchObject({ value: "C02XYZ", mono: true });
    expect(fields.find((f) => f.labelKey === "model")?.value).toBe(
      "Dell Latitude 5520",
    );
  });

  it("drops fields whose value is missing (no model ⇒ no model/category)", () => {
    const fields = selectFields(
      { entity: "asset", data: makeAsset({ serial: null, model: null, location: null }) },
      LABELS,
    );
    // owner is still present (it's the localized "Unassigned" when there are no owners).
    expect(fields.map((f) => f.labelKey)).toEqual(["assetTag", "owner"]);
  });

  it("omits the owner field entirely when no labels are supplied", () => {
    const fields = selectFields({ entity: "asset", data: makeAsset() });
    expect(fields.find((f) => f.labelKey === "owner")).toBeUndefined();
  });
});

describe("asset owner (CEO headline disambiguator)", () => {
  it("shows the single active owner's name", () => {
    const fields = selectFields(
      {
        entity: "asset",
        data: makeAsset({ activeAssignments: [makeAssignment("Ana", "Pérez")] }),
      },
      LABELS,
    );
    expect(fields.find((f) => f.labelKey === "owner")?.value).toBe("Ana Pérez");
  });

  it("shows the first owner + a localized '+N more' when several", () => {
    const fields = selectFields(
      {
        entity: "asset",
        data: makeAsset({
          activeAssignments: [
            makeAssignment("Ana", "Pérez"),
            makeAssignment("Juan", "Díaz"),
            makeAssignment("Lia", "Gómez"),
          ],
        }),
      },
      LABELS,
    );
    expect(fields.find((f) => f.labelKey === "owner")?.value).toBe(
      "Ana Pérez +2 more",
    );
  });

  it("shows the localized 'Unassigned' when there are no active owners", () => {
    const fields = selectFields(
      { entity: "asset", data: makeAsset({ activeAssignments: [] }) },
      LABELS,
    );
    expect(fields.find((f) => f.labelKey === "owner")?.value).toBe("Unassigned");
  });

  it("formatOwners is a pure function over the loaded assignments", () => {
    expect(formatOwners([], LABELS)).toBe("Unassigned");
    expect(formatOwners([makeAssignment("Ana", "Pérez")], LABELS)).toBe(
      "Ana Pérez",
    );
    expect(
      formatOwners(
        [makeAssignment("Ana", "Pérez"), makeAssignment("Juan", "Díaz")],
        LABELS,
      ),
    ).toBe("Ana Pérez +1 more");
  });
});

describe("selectFields — user", () => {
  it("emits email/username/legajo and resolves a linked manager", () => {
    const fields = selectFields({
      entity: "user",
      data: makeUser({
        manager: {
          type: "user",
          id: "mgr_1",
          firstName: "Grace",
          lastName: "Hopper",
          isOffboarded: false,
        },
        assetsInPossession: 3,
        appAccesses: 0,
      }),
    });
    const byKey = Object.fromEntries(fields.map((f) => [f.labelKey, f.value]));
    expect(byKey.email).toBe("ada@example.com");
    expect(byKey.manager).toBe("Grace Hopper");
    // A zero count is a real value (not "missing") — it must still render.
    expect(byKey.apps).toBe("0");
    expect(byKey.assets).toBe("3");
  });

  it("falls back to the free-text external manager name", () => {
    const fields = selectFields({
      entity: "user",
      data: makeUser({ manager: { type: "external", name: "Acme Corp" } }),
    });
    expect(fields.find((f) => f.labelKey === "manager")?.value).toBe(
      "Acme Corp",
    );
  });

  it("omits the activity counts when the row didn't compute them", () => {
    const fields = selectFields({ entity: "user", data: makeUser() });
    expect(fields.find((f) => f.labelKey === "assets")).toBeUndefined();
    expect(fields.find((f) => f.labelKey === "apps")).toBeUndefined();
  });
});

describe("selectFields — application (SEC-008 url gate)", () => {
  const base: Omit<Application, "url"> = {
    id: "app_1",
    name: "Jira",
    description: "Issue tracker",
    vendor: "Atlassian",
    categoryId: null,
    isCritical: false,
    metadata: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };

  it("shows a safe https url as plain text", () => {
    const fields = selectFields({
      entity: "application",
      data: { ...base, url: "https://jira.example.com" },
    });
    expect(fields.find((f) => f.labelKey === "url")?.value).toBe(
      "https://jira.example.com",
    );
  });

  it("drops an unsafe javascript: url", () => {
    const fields = selectFields({
      entity: "application",
      data: { ...base, url: "javascript:alert(1)" },
    });
    expect(fields.find((f) => f.labelKey === "url")).toBeUndefined();
  });
});

describe("detailHref", () => {
  it("links entities that have a detail route", () => {
    expect(detailHref({ entity: "asset", data: makeAsset() })).toBe(
      "/assets/asset_1",
    );
    expect(detailHref({ entity: "user", data: makeUser() })).toBe(
      "/users/user_1",
    );
    expect(
      detailHref({
        entity: "article",
        data: { id: "a1", title: "T", slug: "my-slug", status: "PUBLISHED" },
      }),
    ).toBe("/kb/my-slug");
  });

  it("returns null for entities with no standalone detail route", () => {
    const model: AssetModel = {
      id: "m1",
      name: "X",
      manufacturer: "Y",
      sku: null,
      description: null,
      specs: null,
      categoryId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    expect(detailHref({ entity: "assetModel", data: model })).toBeNull();
    expect(
      detailHref({
        entity: "category",
        data: { id: "c1", name: "Laptops" },
      }),
    ).toBeNull();
  });
});

// A `location` row sanity-check that the order respects the brief (type badge is in the identity row,
// so only address/floor/description are <dl> fields).
describe("selectFields — location", () => {
  it("emits address, floor, description (no type — that's the badge)", () => {
    const loc: Location = {
      id: "loc_1",
      name: "HQ",
      type: "OFFICE",
      description: "Main office",
      address: "1 Main St",
      floor: "PB",
      notes: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const fields = selectFields({ entity: "location", data: loc });
    expect(fields.map((f) => f.labelKey)).toEqual([
      "address",
      "floor",
      "description",
    ]);
  });
});

// An infra node (wave 3, #791) — the new entity variant. The basics (kind/status/IP/linked asset)
// come straight from the lean search hit (zero fetch); status is the identity badge, so the <dl>
// fields are kind, linkedAsset, ip. `kind` is localized via the threaded `infraKind` label (the raw
// enum is the translator-free fallback the test asserts), and the deep-link is the canvas focus URL.
describe("selectFields — infra", () => {
  const node: QuickViewData = {
    entity: "infra",
    data: {
      id: "node_1",
      label: "db-prod-01",
      kind: "VM",
      status: "ONLINE",
      ipAddress: "10.0.0.5",
      assetName: "Dell R740 #3",
    },
  };

  it("emits kind, linkedAsset, ip in order (status is the identity badge, not a field)", () => {
    const fields = selectFields(node);
    expect(fields.map((f) => f.labelKey)).toEqual([
      "kind",
      "linkedAsset",
      "ip",
    ]);
    // No `status` field — it renders as the identity badge.
    expect(fields.find((f) => f.labelKey === "status")).toBeUndefined();
    // IP is monospaced.
    expect(fields.find((f) => f.labelKey === "ip")).toMatchObject({
      value: "10.0.0.5",
      mono: true,
    });
  });

  it("renders the raw kind enum when no infraKind label is supplied", () => {
    const fields = selectFields(node);
    expect(fields.find((f) => f.labelKey === "kind")?.value).toBe("VM");
  });

  it("localizes the kind via the threaded infraKind label", () => {
    const fields = selectFields(node, {
      ...LABELS,
      infraKind: (kind) => `kind:${kind}`,
    });
    expect(fields.find((f) => f.labelKey === "kind")?.value).toBe("kind:VM");
  });

  it("drops linkedAsset + ip when the node is graph-only / has no IP", () => {
    const fields = selectFields({
      entity: "infra",
      data: {
        id: "node_2",
        label: "graph-only",
        kind: "OTHER",
        status: "UNKNOWN",
        ipAddress: null,
        assetName: null,
      },
    });
    expect(fields.map((f) => f.labelKey)).toEqual(["kind"]);
  });
});

describe("titleFor / detailHref — infra", () => {
  const node: QuickViewData = {
    entity: "infra",
    data: { id: "node_1", label: "db-prod-01", kind: "VM", status: "ONLINE" },
  };

  it("uses the node label as the title", () => {
    expect(titleFor(node)).toBe("db-prod-01");
  });

  it("deep-links to the canvas with the focus flag", () => {
    expect(detailHref(node)).toBe("/assets/diagram?node=node_1&focus=1");
  });
});

// Satisfy the unused-import lint when only some constructors are referenced above.
const _typecheck: QuickViewData = { entity: "asset", data: makeAsset() };
void _typecheck;
