import {
  type Capability,
  CAPABILITIES,
  type EditableRole,
  type Permission,
  PERMISSION_META,
  PERMISSION_PRESETS,
  type PermissionPillar,
  type PresetId,
  dependentsOfRead,
  impliedReadOf,
  isAboveDefaultTier,
  permissionSetsEqual,
  withImpliedReads,
} from "@lazyit/shared";
import {
  permissionLabel,
  type SettingsTranslator,
} from "../../_lib/permission-labels";

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

/**
 * Add (`on`) or remove (`off`) a group of permissions, keeping write-implies-read (#1518):
 *   - turning a permission ON also turns on the read it needs (editing something requires seeing it);
 *   - turning a read OFF also turns off every permission that needs it. That removal is never silent:
 *     the read's removal routes the save through the consequential confirm, which names the dependent
 *     permissions that went with it ({@link analyzeSaveDiff}).
 * Only the permissions this toggle touches are cascaded — a write-without-read loaded from a matrix
 * saved before the rule is left as it is here and healed at save ({@link savePayload}).
 * Returns a NEW array (immutably) so React state updates cleanly.
 */
function applyToggle(
  permissions: readonly Permission[],
  staged: readonly Permission[],
  on: boolean,
): Permission[] {
  const next = new Set(staged);
  for (const p of permissions) {
    if (on) {
      next.add(p);
      const read = impliedReadOf(p);
      if (read) next.add(read);
    } else {
      next.delete(p);
      for (const dependent of dependentsOfRead(p)) next.delete(dependent);
    }
  }
  return [...next];
}

/** Toggle every permission of a capability (write-implies-read kept, see {@link applyToggle}). */
export function toggleCapability(
  capability: Capability,
  staged: readonly Permission[],
  on: boolean,
): Permission[] {
  return applyToggle(capability.permissions, staged, on);
}

/** Toggle one raw permission (the fine-tune view; write-implies-read kept, see {@link applyToggle}). */
export function togglePermission(
  permission: Permission,
  staged: readonly Permission[],
  on: boolean,
): Permission[] {
  return applyToggle([permission], staged, on);
}

/**
 * The set a save sends for a role: the staged set with every missing implied read added (#1518). A
 * staged set built by the toggles is already complete; this heals a write-without-read loaded from a
 * matrix saved before the rule (the API would refuse a NEW one with 400 and heals a stored one the same
 * way). It never removes a permission.
 */
export function savePayload(staged: readonly Permission[]): Permission[] {
  return withImpliedReads(staged);
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
  /** Permissions the save removes BECAUSE a read they need was removed (write implies read, #1518). */
  removedDependents: SaveConsequence[];
  /** Reads the save ADDS on its own because a kept permission needs them (a legacy matrix, #1518). */
  impliedReads: SaveConsequence[];
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
 * Compute the human consequences of saving `staged` over `before` for `role`. What is compared is what
 * the save actually sends — {@link savePayload}`(staged)`, so a read the save adds on its own is shown.
 * Drives whether the save needs the confirm dialog and what it says. The consequence classes are the
 * two the CEO flagged (removed reads; above-tier grants) plus the two write-implies-read adds (#1518):
 * the permissions that left with a removed read, and the reads a save adds to heal a legacy matrix.
 * Pure within-tier add/remove is silent. The `t` translator (from the page) renders each sentence.
 */
export function analyzeSaveDiff(
  role: EditableRole,
  before: readonly Permission[],
  staged: readonly Permission[],
  t: ConsequenceTranslator,
): SaveDiff {
  const beforeSet = new Set(before);
  const stagedSet = new Set(staged);
  const afterSet = new Set(savePayload(staged));
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

  const removedDependents: SaveConsequence[] = [];
  for (const p of beforeSet) {
    const read = impliedReadOf(p);
    if (!afterSet.has(p) && read && beforeSet.has(read) && !afterSet.has(read)) {
      removedDependents.push({
        permission: p,
        message: t("roles.permissions.consequence.removedDependent", {
          who,
          action: verbForRead(p, t),
        }),
      });
    }
  }

  const impliedReads: SaveConsequence[] = [];
  for (const p of afterSet) {
    if (!stagedSet.has(p) && !beforeSet.has(p)) {
      impliedReads.push({
        permission: p,
        message: t("roles.permissions.consequence.impliedRead", {
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
    removedDependents,
    impliedReads,
    aboveTierGrants,
    isConsequential:
      removedReads.length > 0 ||
      removedDependents.length > 0 ||
      impliedReads.length > 0 ||
      aboveTierGrants.length > 0,
  };
}

/** A lower-case "see X" / "edit X" phrase for a permission, from its localized label. */
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
