import { describe, expect, test } from "bun:test";
import {
  accessRuleParts,
  type FolderAccessInput,
  ownRestriction,
  restrictedFolderIdSet,
  summarizeFolderAccess,
} from "./kb-folder-access";

const USER_A = "8f0c6a3e-1b2d-4c5e-9f00-000000000001";
const USER_B = "8f0c6a3e-1b2d-4c5e-9f00-000000000002";
const APP = "cmapp0000000000000000000a";
const ASSET = "cmasset000000000000000000";

function folder(
  id: string,
  parentId: string | null,
  extra: Partial<FolderAccessInput> = {},
): FolderAccessInput {
  return { id, parentId, ...extra };
}

describe("ownRestriction", () => {
  test("the #1299 flag answers for every viewer", () => {
    expect(ownRestriction(folder("a", null, { hasAccessRules: true }))).toBe(true);
    expect(ownRestriction(folder("a", null, { hasAccessRules: false }))).toBe(false);
  });
  test("the admin-only rule list answers when the flag is absent", () => {
    expect(ownRestriction(folder("a", null, { accessRules: [{ kind: "role", role: "ADMIN" }] }))).toBe(true);
    expect(ownRestriction(folder("a", null, { accessRules: [] }))).toBe(false);
    expect(ownRestriction(folder("a", null, { accessRules: null }))).toBe(false);
  });
  test("neither signal is unknown, never public", () => {
    expect(ownRestriction(folder("a", null))).toBeNull();
  });
});

describe("restrictedFolderIdSet", () => {
  test("collects only the folders with a rule of their own", () => {
    const set = restrictedFolderIdSet([
      folder("a", null, { hasAccessRules: true }),
      folder("b", "a", { hasAccessRules: false }),
      folder("c", null),
    ]);
    expect([...set]).toEqual(["a"]);
  });
});

describe("accessRuleParts", () => {
  test("merges every users rule into one distinct count, first", () => {
    const parts = accessRuleParts([
      { kind: "role", role: "ADMIN" },
      { kind: "users", userIds: [USER_A, USER_B] },
      { kind: "users", userIds: [USER_B] },
      { kind: "appGrant", applicationId: APP },
      { kind: "assetAssignment", assetId: ASSET },
    ]);
    expect(parts).toEqual([
      { kind: "users", count: 2 },
      { kind: "role", role: "ADMIN" },
      { kind: "appGrant", applicationId: APP },
      { kind: "assetAssignment", assetId: ASSET },
    ]);
  });
  test("a malformed or absent list yields no parts", () => {
    expect(accessRuleParts(undefined)).toEqual([]);
    expect(accessRuleParts(null)).toEqual([]);
    expect(accessRuleParts([{ kind: "nope" }])).toEqual([]);
    expect(accessRuleParts("garbage")).toEqual([]);
  });
});

describe("summarizeFolderAccess", () => {
  test("an admin sees the rules of a restricted folder", () => {
    const folders = [
      folder("a", null, { hasAccessRules: true, accessRules: [{ kind: "role", role: "ADMIN" }] }),
    ];
    expect(summarizeFolderAccess("a", folders)).toEqual({
      state: "restricted",
      parts: [{ kind: "role", role: "ADMIN" }],
    });
  });
  test("other viewers get a bare restricted verdict from the flag", () => {
    const folders = [folder("a", null, { hasAccessRules: true })];
    expect(summarizeFolderAccess("a", folders)).toEqual({ state: "restricted", parts: [] });
  });
  test("a child with no rule of its own inherits from the nearest restricted ancestor", () => {
    const folders = [
      folder("root", null, { hasAccessRules: true }),
      folder("mid", "root", { hasAccessRules: true }),
      folder("leaf", "mid", { hasAccessRules: false }),
    ];
    expect(summarizeFolderAccess("leaf", folders)).toEqual({ state: "inherited", ancestorId: "mid" });
  });
  test("public only when every folder on the path answered", () => {
    const known = [folder("root", null, { hasAccessRules: false }), folder("leaf", "root", { hasAccessRules: false })];
    expect(summarizeFolderAccess("leaf", known)).toEqual({ state: "public" });

    const olderServer = [folder("root", null), folder("leaf", "root", { hasAccessRules: false })];
    expect(summarizeFolderAccess("leaf", olderServer)).toEqual({ state: "unknown" });
  });
  test("an unknown folder is unknown", () => {
    expect(summarizeFolderAccess("missing", [])).toEqual({ state: "unknown" });
  });
  test("a malformed parent cycle terminates", () => {
    const folders = [
      folder("a", "b", { hasAccessRules: false }),
      folder("b", "a", { hasAccessRules: false }),
    ];
    expect(summarizeFolderAccess("a", folders)).toEqual({ state: "public" });
  });
});
