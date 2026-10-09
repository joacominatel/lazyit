import {
  type Capability,
  CAPABILITIES,
  type EditableRole,
  EDITABLE_ROLES,
  type Permission,
  type PermissionPillar,
  PERMISSIONS,
  type RolePermissionMatrix,
} from "@lazyit/shared";
import {
  capabilitiesForPillar,
  capabilityIsFullyOn,
  capabilityIsPartiallyOn,
  type StagedMatrix,
} from "./permissions-form";

/**
 * Pure helpers behind the Roles × capabilities matrix (#1540). No React: the page turns the staged
 * `{ MEMBER, VIEWER }` sets into cell states, per-group n/m summaries and the "Save N changes" count
 * through these, so the rules are unit-tested.
 */

/**
 * The capability groups the matrix renders, in order: every pillar. The per-role editor before the
 * matrix rendered all but `ai`, although the Manual (Permission configuration) documents an AI area
 * with "Use the AI assistant" and "Connect external AI agents" and the catalog carries its labels —
 * the matrix follows the documentation and shows it.
 */
export const MATRIX_PILLARS = [
  "inventory",
  "access",
  "knowledge",
  "manage",
  "automation",
  "ai",
] as const satisfies readonly PermissionPillar[];

/** One matrix cell: every permission of the capability held, some of them, or none. */
export type CellState = "on" | "partial" | "off";

export function cellState(capability: Capability, staged: ReadonlySet<Permission>): CellState {
  if (capabilityIsFullyOn(capability, staged)) return "on";
  if (capabilityIsPartiallyOn(capability, staged)) return "partial";
  return "off";
}

/** Seed both editable roles' staged sets from the server matrix (fresh, mutable copies). */
export function stagedFromMatrix(matrix: RolePermissionMatrix): StagedMatrix {
  return {
    MEMBER: [...(matrix.MEMBER ?? [])],
    VIEWER: [...(matrix.VIEWER ?? [])],
  };
}

/**
 * A group's summary for one column: how many of its capabilities are fully granted, out of how many.
 * A partially granted capability does not count as granted.
 */
export function groupSummary(
  pillar: PermissionPillar,
  staged: ReadonlySet<Permission>,
): { granted: number; total: number } {
  const capabilities = capabilitiesForPillar(pillar);
  return {
    granted: capabilities.filter((c) => capabilityIsFullyOn(c, staged)).length,
    total: capabilities.length,
  };
}

/** Every catalog permission that no capability bundles (only Fine-tune can reach it). */
const UNBUNDLED: readonly Permission[] = PERMISSIONS.filter(
  (p) => !CAPABILITIES.some((c) => c.permissions.includes(p)),
);

/**
 * How many changes a save would write, as the admin sees them: one per (role, capability) cell whose
 * granted permissions differ from the server, plus one per changed permission that no capability
 * bundles. Toggling "View inventory" is ONE change even though it moves five permissions; a Fine-tune
 * edit inside a capability marks that cell as changed. `0` means nothing to save.
 */
export function countMatrixChanges(
  server: RolePermissionMatrix,
  staged: StagedMatrix,
): number {
  let changes = 0;
  for (const role of EDITABLE_ROLES) {
    const before = new Set(server[role] ?? []);
    const after = new Set(staged[role]);
    const differs = (p: Permission) => before.has(p) !== after.has(p);
    for (const capability of CAPABILITIES) {
      if (capability.permissions.some(differs)) changes += 1;
    }
    for (const p of UNBUNDLED) {
      if (differs(p)) changes += 1;
    }
  }
  return changes;
}

/** Whether one editable role's staged set differs from the server's. */
export function roleIsDirty(
  role: EditableRole,
  server: RolePermissionMatrix,
  staged: StagedMatrix,
): boolean {
  const before = new Set(server[role] ?? []);
  const after = new Set(staged[role]);
  if (before.size !== after.size) return true;
  for (const p of after) if (!before.has(p)) return true;
  return false;
}
