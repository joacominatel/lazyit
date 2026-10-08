import { describe, expect, test } from "bun:test";
import {
  buildDefaultRolePermissions,
  CAPABILITY_BY_ID,
  PRESET_BY_ID,
  type RolePermissionMatrix,
} from "@lazyit/shared";
import { capabilitiesForPillar, detectPreset } from "./permissions-form";
import {
  cellState,
  countMatrixChanges,
  groupSummary,
  MATRIX_PILLARS,
  roleIsDirty,
  stagedFromMatrix,
} from "./role-matrix";

const DEFAULTS: RolePermissionMatrix = buildDefaultRolePermissions();

describe("cellState", () => {
  const view = CAPABILITY_BY_ID["inventory.view"];
  test("on when every permission is held, off when none, partial in between", () => {
    expect(cellState(view, new Set(view.permissions))).toBe("on");
    expect(cellState(view, new Set())).toBe("off");
    expect(cellState(view, new Set([view.permissions[0]!]))).toBe("partial");
  });
});

describe("groupSummary", () => {
  test("counts the fully granted capabilities of a group, out of the group's size", () => {
    const inventory = capabilitiesForPillar("inventory");
    const all = new Set(inventory.flatMap((c) => c.permissions));
    expect(groupSummary("inventory", all)).toEqual({
      granted: inventory.length,
      total: inventory.length,
    });
    expect(groupSummary("inventory", new Set())).toEqual({ granted: 0, total: inventory.length });
  });

  test("a partly granted capability does not count", () => {
    const view = CAPABILITY_BY_ID["inventory.view"];
    expect(groupSummary("inventory", new Set([view.permissions[0]!])).granted).toBe(0);
  });

  test("the matrix renders the same five groups the per-role editor did", () => {
    expect([...MATRIX_PILLARS]).toEqual(["inventory", "access", "knowledge", "manage", "automation"]);
  });
});

describe("countMatrixChanges", () => {
  test("nothing staged differently → 0", () => {
    expect(countMatrixChanges(DEFAULTS, stagedFromMatrix(DEFAULTS))).toBe(0);
  });

  test("toggling a multi-permission capability counts as ONE change", () => {
    const view = CAPABILITY_BY_ID["inventory.view"];
    expect(view.permissions.length).toBeGreaterThan(1);
    const staged = stagedFromMatrix(DEFAULTS);
    staged.VIEWER = staged.VIEWER.filter((p) => !view.permissions.includes(p));
    expect(countMatrixChanges(DEFAULTS, staged)).toBe(1);
  });

  test("changes on both roles add up", () => {
    const staged = stagedFromMatrix(DEFAULTS);
    staged.MEMBER = [...staged.MEMBER, ...CAPABILITY_BY_ID["inventory.delete"].permissions];
    staged.VIEWER = staged.VIEWER.filter(
      (p) => !CAPABILITY_BY_ID["inventory.view"].permissions.includes(p),
    );
    expect(countMatrixChanges(DEFAULTS, staged)).toBe(2);
  });

  test("a single fine-tuned permission inside a capability marks that cell changed", () => {
    const view = CAPABILITY_BY_ID["inventory.view"];
    const staged = stagedFromMatrix(DEFAULTS);
    staged.MEMBER = staged.MEMBER.filter((p) => p !== view.permissions[0]);
    expect(countMatrixChanges(DEFAULTS, staged)).toBeGreaterThanOrEqual(1);
  });

  test("tolerates a server matrix missing a role (treated as empty)", () => {
    const partial = { ADMIN: DEFAULTS.ADMIN, MEMBER: DEFAULTS.MEMBER } as RolePermissionMatrix;
    expect(countMatrixChanges(partial, { MEMBER: DEFAULTS.MEMBER, VIEWER: [] })).toBe(0);
  });
});

describe("roleIsDirty", () => {
  test("only the edited role reads as dirty", () => {
    const staged = stagedFromMatrix(DEFAULTS);
    staged.VIEWER = [...PRESET_BY_ID.editor.permissions];
    expect(roleIsDirty("VIEWER", DEFAULTS, staged)).toBe(true);
    expect(roleIsDirty("MEMBER", DEFAULTS, staged)).toBe(false);
  });
});

describe("detectPreset (the column header's selector)", () => {
  test("the seed defaults read as Editor / Read-only; an edit reads as custom", () => {
    expect(detectPreset(DEFAULTS.MEMBER)).toBe("editor");
    expect(detectPreset(DEFAULTS.VIEWER)).toBe("readOnly");
    expect(detectPreset(PRESET_BY_ID.inventoryOperator.permissions)).toBe("inventoryOperator");
    expect(detectPreset(DEFAULTS.VIEWER.slice(1))).toBe("custom");
  });
});
