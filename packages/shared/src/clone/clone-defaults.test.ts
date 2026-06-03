import { describe, expect, test } from "bun:test";
import { CreateApplicationSchema } from "../schemas/application";
import { CreateApplicationCategorySchema } from "../schemas/application-category";
import { CreateArticleCategorySchema } from "../schemas/article-category";
import { CreateAssetSchema } from "../schemas/asset";
import { CreateAssetCategorySchema } from "../schemas/asset-category";
import { CreateAssetModelSchema } from "../schemas/asset-model";
import { CreateConsumableSchema } from "../schemas/consumable";
import { CreateConsumableCategorySchema } from "../schemas/consumable-category";
import { CreateUserSchema } from "../schemas/user";
import {
  CLONE_NAME_SUFFIX,
  cloneApplicationDefaults,
  cloneAssetDefaults,
  cloneAssetModelDefaults,
  cloneCategoryDefaults,
  cloneConsumableDefaults,
  cloneUserDefaults,
  withCopySuffix,
} from "./clone-defaults";

const ISO = "2024-01-02T03:04:05.000Z";

describe("withCopySuffix", () => {
  test("appends the suffix", () => {
    expect(withCopySuffix("Ada's laptop")).toBe(`Ada's laptop${CLONE_NAME_SUFFIX}`);
    expect(withCopySuffix("")).toBe(CLONE_NAME_SUFFIX);
  });
});

describe("cloneAssetDefaults", () => {
  const source = {
    id: "ckasset0000000000000000001",
    name: "Ada's laptop",
    serial: "SN-123",
    assetTag: "LZ-0001",
    status: "OPERATIONAL" as const,
    specs: { ram: "16GB", ports: ["usb-c", "hdmi"] },
    notes: "fragile",
    purchaseDate: ISO,
    warrantyEnd: ISO,
    modelId: "ckmodel00000000000000000001",
    locationId: "cklocation0000000000000001",
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };

  test("suffixes name and copies the carried fields", () => {
    const out = cloneAssetDefaults(source);
    expect(out.name).toBe("Ada's laptop (copy)");
    expect(out.status).toBe("OPERATIONAL");
    expect(out.modelId).toBe(source.modelId);
    expect(out.locationId).toBe(source.locationId);
    expect(out.notes).toBe("fragile");
    expect(out.purchaseDate).toBe(ISO);
    expect(out.warrantyEnd).toBe(ISO);
  });

  test("CLEARS the unique partial-index fields (serial, assetTag)", () => {
    const out = cloneAssetDefaults(source);
    expect(out.serial).toBeUndefined();
    expect(out.assetTag).toBeUndefined();
  });

  test("DEEP-COPIES specs (no aliasing of the source object)", () => {
    const out = cloneAssetDefaults(source);
    expect(out.specs).toEqual(source.specs);
    expect(out.specs).not.toBe(source.specs);
    // mutating the clone must not touch the source
    (out.specs as Record<string, unknown>).ram = "32GB";
    (out.specs!.ports as string[]).push("vga");
    expect(source.specs.ram).toBe("16GB");
    expect(source.specs.ports).toEqual(["usb-c", "hdmi"]);
  });

  test("maps null fields to undefined", () => {
    const out = cloneAssetDefaults({
      ...source,
      specs: null,
      notes: null,
      purchaseDate: null,
      warrantyEnd: null,
      modelId: null,
      locationId: null,
    });
    expect(out.specs).toBeUndefined();
    expect(out.notes).toBeUndefined();
    expect(out.modelId).toBeUndefined();
    expect(out.locationId).toBeUndefined();
  });

  test("the result passes CreateAssetSchema", () => {
    const out = cloneAssetDefaults(source);
    expect(CreateAssetSchema.safeParse(out).success).toBe(true);
  });
});

describe("cloneConsumableDefaults", () => {
  const source = {
    id: "ckconsum000000000000000001",
    name: "USB-C adapter",
    sku: "ADP-USBC-HDMI",
    categoryId: "ckcat00000000000000000001",
    description: "video adapter",
    currentStock: 42,
    minStock: 5,
    unit: "units",
    notes: "buy in bulk",
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };

  test("suffixes name, copies fields, CLEARS sku", () => {
    const out = cloneConsumableDefaults(source);
    expect(out.name).toBe("USB-C adapter (copy)");
    expect(out.categoryId).toBe(source.categoryId);
    expect(out.description).toBe("video adapter");
    expect(out.minStock).toBe(5);
    expect(out.unit).toBe("units");
    expect(out.notes).toBe("buy in bulk");
    expect(out.sku).toBeUndefined();
  });

  test("never carries currentStock into the create payload", () => {
    const out = cloneConsumableDefaults(source);
    expect("currentStock" in out).toBe(false);
  });

  test("the result passes CreateConsumableSchema", () => {
    expect(CreateConsumableSchema.safeParse(cloneConsumableDefaults(source)).success).toBe(true);
  });
});

describe("cloneApplicationDefaults", () => {
  const source = {
    id: "ckapp00000000000000000001",
    name: "GitHub",
    description: "code host",
    url: "https://github.com",
    vendor: "GitHub Inc.",
    categoryId: "ckcat00000000000000000002",
    isCritical: true,
    metadata: { sso: "saml", teams: ["infra"] },
    notes: "prod-critical",
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };

  test("suffixes name, copies fields incl. url and isCritical", () => {
    const out = cloneApplicationDefaults(source);
    expect(out.name).toBe("GitHub (copy)");
    expect(out.description).toBe("code host");
    expect(out.url).toBe("https://github.com");
    expect(out.vendor).toBe("GitHub Inc.");
    expect(out.categoryId).toBe(source.categoryId);
    expect(out.isCritical).toBe(true);
    expect(out.notes).toBe("prod-critical");
  });

  test("DEEP-COPIES metadata", () => {
    const out = cloneApplicationDefaults(source);
    expect(out.metadata).toEqual(source.metadata);
    expect(out.metadata).not.toBe(source.metadata);
    (out.metadata!.teams as string[]).push("sec");
    expect(source.metadata.teams).toEqual(["infra"]);
  });

  test("a safe url survives the create resolver (SEC-008)", () => {
    expect(CreateApplicationSchema.safeParse(cloneApplicationDefaults(source)).success).toBe(true);
    // a scheme-less host also passes through and validates
    const schemeless = cloneApplicationDefaults({ ...source, url: "vpn.corp.local:8080" });
    expect(CreateApplicationSchema.safeParse(schemeless).success).toBe(true);
  });
});

describe("cloneAssetModelDefaults", () => {
  const source = {
    id: "ckmodel00000000000000000001",
    name: "Latitude 5520",
    manufacturer: "Dell",
    sku: "DELL-5520",
    description: "business laptop",
    specs: { ram: "16GB" },
    categoryId: "ckcat00000000000000000003",
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };

  test("suffixes name, copies manufacturer/description/category, CLEARS sku", () => {
    const out = cloneAssetModelDefaults(source);
    expect(out.name).toBe("Latitude 5520 (copy)");
    expect(out.manufacturer).toBe("Dell");
    expect(out.description).toBe("business laptop");
    expect(out.categoryId).toBe(source.categoryId);
    expect(out.sku).toBeUndefined();
  });

  test("DEEP-COPIES specs", () => {
    const out = cloneAssetModelDefaults(source);
    expect(out.specs).toEqual(source.specs);
    expect(out.specs).not.toBe(source.specs);
  });

  test("the result passes CreateAssetModelSchema", () => {
    expect(CreateAssetModelSchema.safeParse(cloneAssetModelDefaults(source)).success).toBe(true);
  });
});

describe("cloneCategoryDefaults", () => {
  test("asset category (no order): suffixes name, carries description/icon, no order key", () => {
    const source = {
      id: "ckcat00000000000000000001",
      name: "Laptops",
      description: "portable computers",
      icon: "ServerStackIcon",
      createdAt: ISO,
      updatedAt: ISO,
      deletedAt: null,
    };
    const out = cloneCategoryDefaults(source);
    expect(out.name).toBe("Laptops (copy)");
    expect(out.description).toBe("portable computers");
    expect(out.icon).toBe("ServerStackIcon");
    expect("order" in out).toBe(false);
    expect(CreateAssetCategorySchema.safeParse(out).success).toBe(true);
  });

  test("ordered categories carry the order sort key", () => {
    const ordered = {
      id: "ckcat00000000000000000002",
      name: "SaaS",
      description: "cloud apps",
      icon: "CloudIcon",
      order: 3,
      createdAt: ISO,
      updatedAt: ISO,
      deletedAt: null,
    };
    const out = cloneCategoryDefaults(ordered);
    expect(out.name).toBe("SaaS (copy)");
    expect(out.order).toBe(3);
    expect(CreateApplicationCategorySchema.safeParse(out).success).toBe(true);
    expect(CreateConsumableCategorySchema.safeParse(out).success).toBe(true);
    expect(CreateArticleCategorySchema.safeParse(out).success).toBe(true);
  });

  test("a null order maps to undefined", () => {
    const out = cloneCategoryDefaults({
      id: "ckcat00000000000000000003",
      name: "Misc",
      description: null,
      icon: null,
      order: null,
      createdAt: ISO,
      updatedAt: ISO,
      deletedAt: null,
    });
    expect(out.order).toBeUndefined();
    expect(out.description).toBeUndefined();
    expect(out.icon).toBeUndefined();
  });
});

describe("cloneUserDefaults (SECURITY-SENSITIVE)", () => {
  const source = {
    id: "11111111-1111-1111-1111-111111111111",
    email: "ada@lazyit.dev",
    firstName: "Ada",
    lastName: "Lovelace",
    isActive: true,
    role: "ADMIN" as const,
    externalId: "idp-sub-123",
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };

  test("copies only firstName/lastName", () => {
    const out = cloneUserDefaults(source);
    expect(out.firstName).toBe("Ada");
    expect(out.lastName).toBe("Lovelace");
  });

  test("email is forced empty (never auto-suffixed)", () => {
    expect(cloneUserDefaults(source).email).toBe("");
  });

  test("NEVER carries externalId (SEC-006)", () => {
    expect("externalId" in cloneUserDefaults(source)).toBe(false);
  });

  test("OMITS role so the server applies the default VIEWER (least privilege)", () => {
    const out = cloneUserDefaults(source);
    expect("role" in out).toBe(false);
  });

  test("never carries isActive/id/timestamps", () => {
    const out = cloneUserDefaults(source) as Record<string, unknown>;
    expect("isActive" in out).toBe(false);
    expect("id" in out).toBe(false);
    expect("createdAt" in out).toBe(false);
  });

  test("the (email-filled) result passes CreateUserSchema; the empty email fails until filled", () => {
    const out = cloneUserDefaults(source);
    // empty email is invalid → the form forces the operator to supply one
    expect(CreateUserSchema.safeParse(out).success).toBe(false);
    // with a fresh address it validates, and crucially carries no role/externalId
    const filled = { ...out, email: "grace@lazyit.dev" };
    const parsed = CreateUserSchema.safeParse(filled);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("role" in parsed.data).toBe(false);
      expect("externalId" in parsed.data).toBe(false);
    }
  });
});
