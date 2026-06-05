import {
  type Capability,
  CAPABILITIES,
  type EditableRole,
  type Permission,
  PERMISSION_META,
  PERMISSION_PRESETS,
  type PermissionPillar,
  type PresetId,
  isAboveDefaultTier,
  permissionSetsEqual,
} from "@lazyit/shared";
import {
  permissionLabel,
  type SettingsTranslator,
} from "../../../_lib/permission-labels";

/**
 * Web-local (presentation) helpers for the role permissions editor. PURE — no React, no fetching.
 * They turn a staged `Permission[]` into the things the screen renders: which preset (if any) it
 * matches, the capability/fine-tune toggle states, and the human consequences of a save diff.
 *
 * They deliberately live in `web`, not `@lazyit/shared`: the catalog + capability/preset DATA is
 * shared (so the covering-set test guards it), but how the editor diffs and phrases a save is UI
 * concern. The wire contract is still the flat `Permission[]` per role.
 */

/** The staged permission sets for BOTH editable roles — held together so editing one never clobbers
 * the other (a PUT replaces both). */
export type StagedMatrix = Record<EditableRole, Permission[]>;

/**
 * Which preset the staged set matches, or `"custom"` when it matches none. The presets are full sets,
 * so this is an exact set-equality check — the moment a manual edit breaks the match, the screen flips
 * to "Custom".
 */
export function detectPreset(staged: readonly Permission[]): PresetId | "custom" {
  for (const preset of PERMISSION_PRESETS) {
    if (permissionSetsEqual(staged, preset.permissions)) return preset.id;
  }
  return "custom";
}

/** Whether EVERY permission of a capability is present in the staged set (a fully-on toggle). */
export function capabilityIsFullyOn(
  capability: Capability,
  staged: ReadonlySet<Permission>,
): boolean {
  return capability.permissions.every((p) => staged.has(p));
}

/** Whether SOME (but not all) of a capability's permissions are present — a partial/indeterminate
 * toggle (e.g. only some inventory domains have :write after a fine-tune edit). */
export function capabilityIsPartiallyOn(
  capability: Capability,
  staged: ReadonlySet<Permission>,
): boolean {
  const on = capability.permissions.filter((p) => staged.has(p)).length;
  return on > 0 && on < capability.permissions.length;
}

/** Add (`on`) or remove (`off`) every permission of a capability from a staged set. Returns a NEW
 * array (immutably) so React state updates cleanly. */
export function toggleCapability(
  capability: Capability,
  staged: readonly Permission[],
  on: boolean,
): Permission[] {
  const next = new Set(staged);
  for (const p of capability.permissions) {
    if (on) next.add(p);
    else next.delete(p);
  }
  return [...next];
}

/** Add or remove a single raw permission (the fine-tune view) from a staged set. */
export function togglePermission(
  permission: Permission,
  staged: readonly Permission[],
  on: boolean,
): Permission[] {
  const next = new Set(staged);
  if (on) next.add(permission);
  else next.delete(permission);
  return [...next];
}

/** The capabilities of a given pillar, in catalog/display order. */
export function capabilitiesForPillar(pillar: PermissionPillar): Capability[] {
  return CAPABILITIES.filter((c) => c.pillar === pillar);
}

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Save-diff analysis — the tiered consequential-change confirm (CEO design). A save routes through a
 * neutral-tone confirm ONLY when it does something a person would want to double-check: it REMOVES a
 * read the role currently has, or it GRANTS an above-default-tier capability (a :delete or a coarse
 * verb). Trivial within-tier toggles save straight through (no dialog) — avoiding warning fatigue.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

export interface SaveConsequence {
  /** The permission involved. */
  permission: Permission;
  /** Human-readable sentence describing the real-world effect for THIS role. */
  message: string;
}

export interface SaveDiff {
  /** Reads the save REMOVES from the role (each may hide a surface). */
  removedReads: SaveConsequence[];
  /** Above-default-tier permissions the save GRANTS to the role (admin-level delegation). */
  aboveTierGrants: SaveConsequence[];
  /** True when the diff has at least one consequence → route through the confirm dialog. */
  isConsequential: boolean;
}

/**
 * The minimal translator shape the consequence builders need: a `t(key, values?)` over the
 * `settings` namespace (matches next-intl's `useTranslations("settings")`). The page passes its
 * own `t`, so the human consequence sentences — and the localized permission labels they embed
 * (issue #215) — come from the catalog rather than being hardcoded. Aliased to `SettingsTranslator`
 * so the same `t` resolves both the consequence keys and the `permissionMeta.*` label keys.
 */
export type ConsequenceTranslator = SettingsTranslator;

/**
 * Compute the human consequences of replacing `before` with `after` for `role`. Drives whether the
 * save needs the confirm dialog and what it says. Only the two consequence classes the CEO flagged
 * are surfaced (removed reads; above-tier grants); pure within-tier add/remove is silent. The
 * `t` translator (from the page) renders each consequence sentence from the catalog.
 */
export function analyzeSaveDiff(
  role: EditableRole,
  before: readonly Permission[],
  after: readonly Permission[],
  t: ConsequenceTranslator,
): SaveDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const who = t(`roles.permissions.consequence.who.${role}`);

  const removedReads: SaveConsequence[] = [];
  for (const p of beforeSet) {
    if (!afterSet.has(p) && PERMISSION_META[p].tier === "view") {
      removedReads.push({
        permission: p,
        message: t("roles.permissions.consequence.removedRead", {
          who,
          action: verbForRead(p, t),
        }),
      });
    }
  }

  const aboveTierGrants: SaveConsequence[] = [];
  for (const p of afterSet) {
    if (!beforeSet.has(p) && isAboveDefaultTier(p)) {
      aboveTierGrants.push({
        permission: p,
        message: consequenceForAboveTier(p, who, t),
      });
    }
  }

  return {
    removedReads,
    aboveTierGrants,
    isConsequential: removedReads.length > 0 || aboveTierGrants.length > 0,
  };
}

/** A lower-case "see X" phrase for a removed read, from the permission's localized label. */
function verbForRead(permission: Permission, t: SettingsTranslator): string {
  const label = permissionLabel(t, permission);
  // Labels start with a capitalized verb ("View assets", "Read the Knowledge Base"; in es "Ver
  // activos", "Leer la base de conocimiento"); lower-case the first letter for the mid-sentence form.
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The strongly-worded consequence sentence for granting an above-default-tier permission. */
function consequenceForAboveTier(
  permission: Permission,
  who: string,
  t: ConsequenceTranslator,
): string {
  switch (permission) {
    case "accessGrant:grant":
      return t("roles.permissions.consequence.accessGrantGrant", { who });
    case "user:manage":
      return t("roles.permissions.consequence.userManage", { who });
    case "settings:manage":
      return t("roles.permissions.consequence.settingsManage", { who });
    default: {
      // Every other above-tier permission is a :delete.
      const action = permissionLabel(t, permission).toLowerCase();
      return t("roles.permissions.consequence.deleteDefault", { who, action });
    }
  }
}
