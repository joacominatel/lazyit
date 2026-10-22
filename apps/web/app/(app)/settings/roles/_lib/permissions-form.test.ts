import { describe, expect, test } from "bun:test";
import {
  buildDefaultRolePermissions,
  CAPABILITY_BY_ID,
  missingImpliedReads,
  type Permission,
} from "@lazyit/shared";
import {
  analyzeSaveDiff,
  type ConsequenceTranslator,
  savePayload,
  toggleCapability,
  togglePermission,
} from "./permissions-form";

// Write implies read in the matrix editor (#1518): a toggle never leaves a write without its read, an
// un-ticked read takes what needs it along, and the save diff names both — plus any read a save adds
// to heal a matrix stored before the rule.

/** An echoing translator: the key plus its values, enough to assert which sentence was chosen. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}|${JSON.stringify(values)}` : key) as unknown as ConsequenceTranslator;

const DEFAULTS = buildDefaultRolePermissions();
const sorted = (perms: readonly Permission[]) => [...perms].sort();

describe("toggles keep write-implies-read", () => {
  test("turning a write on turns its read on", () => {
    expect(sorted(togglePermission("user:manage", [], true))).toEqual(
      sorted(["user:manage", "user:read"]),
    );
    const editInventory = CAPABILITY_BY_ID["inventory.edit"];
    const next = toggleCapability(editInventory, [], true);
    expect(missingImpliedReads(next)).toEqual([]);
    expect(next).toContain("asset:read");
    expect(next).toContain("location:read");
  });

  test("turning a read off turns off what needs it, and nothing else", () => {
    const next = togglePermission(
      "asset:read",
      ["asset:read", "asset:write", "asset:delete", "location:read", "location:write"],
      false,
    );
    expect(sorted(next)).toEqual(sorted(["location:read", "location:write"]));
    const viewInventory = CAPABILITY_BY_ID["inventory.view"];
    expect(missingImpliedReads(toggleCapability(viewInventory, DEFAULTS.MEMBER, false))).toEqual(
      [],
    );
  });

  test("turning a write off leaves the read alone", () => {
    expect(togglePermission("asset:write", ["asset:read", "asset:write"], false)).toEqual([
      "asset:read",
    ]);
  });

  test("an exempt verb drags nothing in", () => {
    expect(togglePermission("accessRequest:create", [], true)).toEqual(["accessRequest:create"]);
  });
});

describe("savePayload", () => {
  test("adds the read a legacy write-without-read lacks, and never drops the write", () => {
    expect(sorted(savePayload(["asset:write"]))).toEqual(sorted(["asset:read", "asset:write"]));
  });
  test("leaves a complete set unchanged", () => {
    expect(sorted(savePayload(DEFAULTS.MEMBER))).toEqual(sorted(DEFAULTS.MEMBER));
  });
});

describe("analyzeSaveDiff — write implies read", () => {
  test("an un-ticked read is consequential and names the permissions that went with it", () => {
    const before = ["asset:read", "asset:write", "location:read"] as Permission[];
    const staged = togglePermission("asset:read", before, false);
    const diff = analyzeSaveDiff("MEMBER", before, staged, t);
    expect(diff.isConsequential).toBe(true);
    expect(diff.removedReads.map((c) => c.permission)).toEqual(["asset:read"]);
    expect(diff.removedDependents.map((c) => c.permission)).toEqual(["asset:write"]);
    expect(diff.removedDependents[0]!.message).toStartWith(
      "roles.permissions.consequence.removedDependent|",
    );
  });

  test("a save that heals a legacy matrix lists the reads it adds", () => {
    const legacy = ["asset:write", "location:read"] as Permission[];
    const diff = analyzeSaveDiff("VIEWER", legacy, legacy, t);
    expect(diff.isConsequential).toBe(true);
    expect(diff.impliedReads.map((c) => c.permission)).toEqual(["asset:read"]);
    expect(diff.removedReads).toEqual([]);
  });

  test("ticking a write (which brings its read) adds no implied-read notice", () => {
    const before = ["location:read"] as Permission[];
    const staged = togglePermission("asset:write", before, true);
    const diff = analyzeSaveDiff("MEMBER", before, staged, t);
    expect(diff.impliedReads).toEqual([]);
    expect(diff.removedDependents).toEqual([]);
    expect(diff.isConsequential).toBe(false);
  });
});
