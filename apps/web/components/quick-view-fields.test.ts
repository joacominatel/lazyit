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
  type QuickViewData,
  selectFields,
  titleFor,
} from "./quick-view-fields";

/**
 * Unit tests for the PURE Quick View presenter (ADR-0072). The component rendering is not e2e'd
 * (frontend e2e is deferred, ADR-0012); this locks the load-bearing field selection: per-entity
 * order, empty-value dropping, the SEC-008 url gate, and the no-detail-route entities.
 */

const NOW = "2026-06-24T00:00:00.000Z";

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
  it("emits serial, assetTag, model, category, location in order", () => {
    const fields = selectFields({ entity: "asset", data: makeAsset() });
    expect(fields.map((f) => f.labelKey)).toEqual([
      "serial",
      "assetTag",
      "model",
      "category",
      "location",
    ]);
    expect(fields[0]).toMatchObject({ value: "C02XYZ", mono: true });
    expect(fields.find((f) => f.labelKey === "model")?.value).toBe(
      "Dell Latitude 5520",
    );
  });

  it("drops fields whose value is missing (no model ⇒ no model/category)", () => {
    const fields = selectFields({
      entity: "asset",
      data: makeAsset({ serial: null, model: null, location: null }),
    });
    expect(fields.map((f) => f.labelKey)).toEqual(["assetTag"]);
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

// Satisfy the unused-import lint when only some constructors are referenced above.
const _typecheck: QuickViewData = { entity: "asset", data: makeAsset() };
void _typecheck;
