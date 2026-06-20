import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from "./permission";
import {
  ABOVE_DEFAULT_TIERS,
  CAPABILITIES,
  CAPABILITY_BY_ID,
  CAPABILITY_IDS,
  PERMISSION_META,
  PERMISSION_PILLARS,
  PERMISSION_PRESETS,
  PERMISSION_TIERS,
  PILLAR_META,
  PRESET_BY_ID,
  PRESET_IDS,
  capabilityIsAboveDefaultTier,
  isAboveDefaultTier,
  normalizePermissionSet,
  permissionSetsEqual,
} from "./permission-meta";

// Roles & Permissions v2 — P7 (ADR-0046): the COVERING-SET guard. The human layer (labels/pillars/
// tiers + capabilities + presets) must stay 1:1 with the frozen catalog. If it ever drifts — a new
// permission with no label, a capability pointing at a non-existent literal, a preset granting a
// removed permission — these tests fail in the shared package, before the UI can render a hole.

describe("PERMISSION_META — covering set over the catalog", () => {
  test("every catalog permission has exactly one META entry", () => {
    const metaKeys = Object.keys(PERMISSION_META).sort();
    const catalog = [...PERMISSIONS].sort();
    expect(metaKeys).toEqual(catalog);
  });

  test("META has no entry that is NOT in the catalog", () => {
    const catalog = new Set<string>(PERMISSIONS);
    for (const key of Object.keys(PERMISSION_META)) {
      expect(catalog.has(key)).toBe(true);
    }
  });

  test("every permission has exactly one non-empty label", () => {
    const labels = new Map<string, Permission[]>();
    for (const p of PERMISSIONS) {
      const { label } = PERMISSION_META[p];
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
      labels.set(label, [...(labels.get(label) ?? []), p]);
    }
    // Labels are human-facing; each must be unique so the fine-tune view is unambiguous.
    for (const [label, perms] of labels) {
      expect(`${label}: ${perms.join(",")}`).toBe(`${label}: ${perms[0]}`);
    }
  });

  test("every permission has exactly one known pillar", () => {
    const pillars = new Set<string>(PERMISSION_PILLARS);
    for (const p of PERMISSIONS) {
      expect(pillars.has(PERMISSION_META[p].pillar)).toBe(true);
    }
  });

  test("every permission has a known tier", () => {
    const tiers = new Set<string>(PERMISSION_TIERS);
    for (const p of PERMISSIONS) {
      expect(tiers.has(PERMISSION_META[p].tier)).toBe(true);
    }
  });

  test("the tier matches the permission's action suffix", () => {
    for (const p of PERMISSIONS) {
      const action = p.split(":")[1]!;
      const { tier } = PERMISSION_META[p];
      if (action === "read") expect(tier).toBe("view");
      else if (action === "write") expect(tier).toBe("edit");
      else if (action === "delete") expect(tier).toBe("delete");
      // grant / manage are the coarse verbs
      else expect(tier).toBe("coarse");
    }
  });

  test("every pillar has display copy", () => {
    for (const pillar of PERMISSION_PILLARS) {
      expect(PILLAR_META[pillar]?.label.trim().length).toBeGreaterThan(0);
      expect(PILLAR_META[pillar]?.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("Above-default-tier markers", () => {
  test("the above-default tiers are exactly delete + coarse", () => {
    expect([...ABOVE_DEFAULT_TIERS].sort()).toEqual(["coarse", "delete"]);
  });

  test("isAboveDefaultTier is true for every :delete and coarse verb, false otherwise", () => {
    for (const p of PERMISSIONS) {
      const tier = PERMISSION_META[p].tier;
      const expected = tier === "delete" || tier === "coarse";
      expect(isAboveDefaultTier(p)).toBe(expected);
    }
  });

  test("the coarse verbs are exactly the above-default capability verbs (core + workflow + secret + import)", () => {
    const coarse = PERMISSIONS.filter((p) => PERMISSION_META[p].tier === "coarse");
    expect([...coarse].sort()).toEqual(
      [
        "accessGrant:grant",
        "settings:manage",
        "user:manage",
        // workflow coarse verbs (epic #248) — `read` is a view tier, the other four are coarse
        "workflow:manage",
        "workflow:run",
        "workflow:task",
        "workflow:secrets",
        // secret coarse verb (ADR-0061 §7) — `read` is a view tier (admin-only); `manage` is coarse
        "secret:manage",
        // import coarse verb (Migrator, ADR-0069 §11) — the run-only verb that gates the import wizard
        "import:run",
      ].sort(),
    );
  });

  test("no MEMBER/VIEWER seed-default permission is above default tier", () => {
    // The whole point of the marker: a role's default never holds a delete/coarse verb.
    for (const role of ["MEMBER", "VIEWER"] as const) {
      for (const p of DEFAULT_ROLE_PERMISSIONS[role]) {
        expect(isAboveDefaultTier(p)).toBe(false);
      }
    }
  });
});

describe("CAPABILITIES — the human toggle layer", () => {
  test("every capability id is unique and matches CAPABILITY_IDS", () => {
    const ids = CAPABILITIES.map((c) => c.id).sort();
    expect(ids).toEqual([...CAPABILITY_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every capability references ONLY real catalog literals", () => {
    const catalog = new Set<string>(PERMISSIONS);
    for (const cap of CAPABILITIES) {
      expect(cap.permissions.length).toBeGreaterThan(0);
      for (const p of cap.permissions) {
        expect(catalog.has(p)).toBe(true);
      }
    }
  });

  test("every capability has a label, description and known pillar", () => {
    const pillars = new Set<string>(PERMISSION_PILLARS);
    for (const cap of CAPABILITIES) {
      expect(cap.label.trim().length).toBeGreaterThan(0);
      expect(cap.description.trim().length).toBeGreaterThan(0);
      expect(pillars.has(cap.pillar)).toBe(true);
    }
  });

  test("a capability's permissions all live in the capability's own pillar", () => {
    for (const cap of CAPABILITIES) {
      for (const p of cap.permissions) {
        expect(PERMISSION_META[p].pillar).toBe(cap.pillar);
      }
    }
  });

  test("CAPABILITY_BY_ID resolves every id", () => {
    for (const id of CAPABILITY_IDS) {
      expect(CAPABILITY_BY_ID[id]?.id).toBe(id);
    }
  });

  test("capabilityIsAboveDefaultTier is true iff any permission is above tier", () => {
    for (const cap of CAPABILITIES) {
      const expected = cap.permissions.some(isAboveDefaultTier);
      expect(capabilityIsAboveDefaultTier(cap)).toBe(expected);
    }
    // Concretely: the delete + coarse-verb capabilities are above tier.
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["inventory.delete"])).toBe(true);
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["accessGrant.grant"])).toBe(true);
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["user.manage"])).toBe(true);
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["settings.manage"])).toBe(true);
    // …and the view/edit capabilities are NOT.
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["inventory.view"])).toBe(false);
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["inventory.edit"])).toBe(false);
  });

  test("no two capabilities claim the same permission (no double-coverage)", () => {
    const seen = new Map<string, string>();
    for (const cap of CAPABILITIES) {
      for (const p of cap.permissions) {
        expect(seen.has(p)).toBe(false);
        seen.set(p, cap.id);
      }
    }
  });
});

describe("Automation pillar — the workflow capabilities (epic #248)", () => {
  test("the automation pillar exists with display copy", () => {
    expect(PERMISSION_PILLARS).toContain("automation");
    expect(PILLAR_META.automation?.label.trim().length).toBeGreaterThan(0);
    expect(PILLAR_META.automation?.description.trim().length).toBeGreaterThan(0);
  });

  test("every workflow permission has automation-pillar META", () => {
    for (const p of [
      "workflow:read",
      "workflow:manage",
      "workflow:run",
      "workflow:task",
      "workflow:secrets",
    ] as const) {
      expect(PERMISSION_META[p].pillar).toBe("automation");
    }
  });

  test("the workflow capabilities cover each workflow verb 1:1", () => {
    const automationCaps = CAPABILITIES.filter((c) => c.pillar === "automation");
    const covered = automationCaps.flatMap((c) => c.permissions).sort();
    expect(covered).toEqual(
      [
        "workflow:read",
        "workflow:manage",
        "workflow:run",
        "workflow:task",
        "workflow:secrets",
      ].sort(),
    );
  });

  test("workflow.view is within-tier; manage/run/task/secrets are above-default (⚠ admin-level)", () => {
    expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID["workflow.view"])).toBe(false);
    for (const id of [
      "workflow.manage",
      "workflow.run",
      "workflow.task",
      "workflow.secrets",
    ] as const) {
      expect(capabilityIsAboveDefaultTier(CAPABILITY_BY_ID[id])).toBe(true);
    }
  });
});

describe("PERMISSION_PRESETS — the one-click bundles", () => {
  test("every preset id is unique and matches PRESET_IDS", () => {
    const ids = PERMISSION_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual([...PRESET_IDS].sort());
  });

  test("every preset grants ONLY real catalog literals", () => {
    const catalog = new Set<string>(PERMISSIONS);
    for (const preset of PERMISSION_PRESETS) {
      for (const p of preset.permissions) {
        expect(catalog.has(p)).toBe(true);
      }
    }
  });

  test("the Editor preset equals the MEMBER seed default", () => {
    expect(
      permissionSetsEqual(PRESET_BY_ID.editor.permissions, DEFAULT_ROLE_PERMISSIONS.MEMBER),
    ).toBe(true);
  });

  test("the Read-only preset equals the VIEWER seed default", () => {
    expect(
      permissionSetsEqual(PRESET_BY_ID.readOnly.permissions, DEFAULT_ROLE_PERMISSIONS.VIEWER),
    ).toBe(true);
  });

  test("the Inventory operator preset is read everywhere + inventory writes, no deletes/coarse", () => {
    const op = PRESET_BY_ID.inventoryOperator.permissions;
    // It holds every inventory :write…
    for (const p of ["asset:write", "consumable:write", "assetModel:write", "category:write", "location:write"] as const) {
      expect(op).toContain(p);
    }
    // …no NON-inventory write, no delete, no coarse verb…
    for (const p of op) {
      expect(isAboveDefaultTier(p)).toBe(false);
      if (p.endsWith(":write")) {
        expect(PERMISSION_META[p].pillar).toBe("inventory");
      }
    }
    // …and it does NOT leak the two pre-tightened sensitive reads nor the admin-only reads
    // (logs:read) — it stays aligned with the read-only / VIEWER baseline.
    expect(op).not.toContain("accessGrant:read" as Permission);
    expect(op).not.toContain("user:read" as Permission);
    expect(op).not.toContain("logs:read" as Permission);
  });
});

describe("set helpers", () => {
  test("normalizePermissionSet dedups and orders by catalog index", () => {
    const out = normalizePermissionSet([
      "asset:write",
      "asset:read",
      "asset:read",
    ]);
    expect(out).toEqual(["asset:read", "asset:write"]);
  });

  test("permissionSetsEqual is order- and duplicate-independent", () => {
    expect(
      permissionSetsEqual(["asset:read", "asset:write"], ["asset:write", "asset:read", "asset:read"]),
    ).toBe(true);
    expect(permissionSetsEqual(["asset:read"], ["asset:read", "asset:write"])).toBe(false);
  });
});
