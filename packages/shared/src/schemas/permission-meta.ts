import {
  ADMIN_ONLY_READS,
  type Permission,
  PERMISSIONS,
  buildDefaultRolePermissions,
} from "./permission";

/**
 * The HUMAN layer over the frozen Permission catalog (ADR-0046, P7 config UI). This file maps every
 * machine `domain:action` literal to a plain-language label, the product pillar it belongs to and its
 * action TIER, and groups the literals into operator-facing CAPABILITIES (the toggles the role config
 * screen actually renders). It is the single place the UI's wording lives, so the screen never
 * hard-codes labels and can never drift from the catalog — a covering-set test
 * (`permission-meta.test.ts`) asserts every catalog literal has exactly one entry here and every
 * capability references only real catalog literals.
 *
 * Why it lives in `@lazyit/shared` (not `web`): the labels/pillars describe the catalog, which is the
 * shared contract; keeping the human layer beside the catalog makes the covering-set test the guard
 * that the wording and the machine catalog evolve together (add a permission → the test fails until
 * it is labeled and bucketed). It is pure data + pure helpers — no React, no app deps.
 *
 * IMPORTANT — this is presentation metadata only. It does NOT grant or deny anything: authorization is
 * always the DB-first `RolePermission` rows resolved server-side (INV-1). A capability is just a
 * convenient bundling of one or more permissions for a human toggle; the wire PUT is still the flat
 * `Permission[]` per role.
 */

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Pillars — the four product areas the lazyit nav groups domains under. Permissions are bucketed by
 * pillar so the config screen can render capability groups that match the rest of the app's mental
 * model (Inventory / Access / Knowledge / Manage) rather than the flat domain list.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
export const PERMISSION_PILLARS = [
  "inventory",
  "access",
  "knowledge",
  "manage",
] as const;
export type PermissionPillar = (typeof PERMISSION_PILLARS)[number];

/** Display copy for each pillar (English-everywhere); the screen renders these as group headers. */
export const PILLAR_META: Record<
  PermissionPillar,
  { label: string; description: string }
> = {
  inventory: {
    label: "Inventory",
    description: "Assets, consumables, models, categories and locations.",
  },
  access: {
    label: "Access",
    description: "Applications and who can access them.",
  },
  knowledge: {
    label: "Knowledge",
    description: "The Knowledge Base — articles and their categories.",
  },
  manage: {
    label: "Manage",
    description: "Users, instance settings, the dashboard and search.",
  },
};

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Action tiers — the privilege level of a single permission, independent of its domain. Drives the
 * "above default tier" warning: a role's seed default never includes `delete` or a coarse verb, so
 * granting those to MEMBER/VIEWER is an admin-level escalation the UI warns about (CEO: allowed with a
 * strong warning, never client-blocked — the backend has no block either; ADR-0046 P5/P7).
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
export const PERMISSION_TIERS = ["view", "edit", "delete", "coarse"] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];

/** Per-permission presentation metadata: a human label, its pillar and its action tier. */
export interface PermissionMeta {
  /** Plain-language label for the single permission (used in the fine-tune view + summaries). */
  readonly label: string;
  /** The product pillar this permission's domain belongs to. */
  readonly pillar: PermissionPillar;
  /** The privilege tier (drives the above-default-tier admin-level warning). */
  readonly tier: PermissionTier;
}

/**
 * The label/pillar/tier for EVERY permission in the catalog. Hand-written (not generated) so each
 * line is greppable and reviewable; the covering-set test guarantees it stays 1:1 with `PERMISSIONS`.
 * `coarse` tier marks the three above-default capability verbs (`accessGrant:grant`, `user:manage`,
 * `settings:manage`); `delete` marks every destructive lifecycle permission.
 */
export const PERMISSION_META: Record<Permission, PermissionMeta> = {
  // ── Inventory ──────────────────────────────────────────────────────────────
  "asset:read": { label: "View assets", pillar: "inventory", tier: "view" },
  "asset:write": { label: "Add & edit assets", pillar: "inventory", tier: "edit" },
  "asset:delete": { label: "Delete assets", pillar: "inventory", tier: "delete" },
  "consumable:read": { label: "View consumables", pillar: "inventory", tier: "view" },
  "consumable:write": {
    label: "Add, edit & adjust consumables",
    pillar: "inventory",
    tier: "edit",
  },
  "consumable:delete": {
    label: "Delete consumables",
    pillar: "inventory",
    tier: "delete",
  },
  "assetModel:read": { label: "View asset models", pillar: "inventory", tier: "view" },
  "assetModel:write": {
    label: "Add & edit asset models",
    pillar: "inventory",
    tier: "edit",
  },
  "assetModel:delete": {
    label: "Delete asset models",
    pillar: "inventory",
    tier: "delete",
  },
  "category:read": { label: "View categories", pillar: "inventory", tier: "view" },
  "category:write": {
    label: "Add & edit categories",
    pillar: "inventory",
    tier: "edit",
  },
  "category:delete": {
    label: "Delete categories",
    pillar: "inventory",
    tier: "delete",
  },
  "location:read": { label: "View locations", pillar: "inventory", tier: "view" },
  "location:write": {
    label: "Add & edit locations",
    pillar: "inventory",
    tier: "edit",
  },
  "location:delete": {
    label: "Delete locations",
    pillar: "inventory",
    tier: "delete",
  },
  // ── Access ─────────────────────────────────────────────────────────────────
  "application:read": { label: "View applications", pillar: "access", tier: "view" },
  "application:write": {
    label: "Add & edit applications",
    pillar: "access",
    tier: "edit",
  },
  "application:delete": {
    label: "Delete applications",
    pillar: "access",
    tier: "delete",
  },
  "accessGrant:read": {
    label: "See who has access",
    pillar: "access",
    tier: "view",
  },
  "accessGrant:write": {
    // The "intentional orphan" write slot (ADR-0046 P4): MEMBER holds it by the seed :write rule,
    // but no endpoint enforces it — Access mutations gate on `accessGrant:grant`. Kept labeled for
    // catalog coverage; surfaced only in the fine-tune view, never as a capability toggle.
    label: "Edit access records (reserved)",
    pillar: "access",
    tier: "edit",
  },
  "accessGrant:delete": {
    label: "Delete access records",
    pillar: "access",
    tier: "delete",
  },
  "accessGrant:grant": {
    label: "Grant & revoke access",
    pillar: "access",
    tier: "coarse",
  },
  // ── Knowledge ──────────────────────────────────────────────────────────────
  "article:read": { label: "Read the Knowledge Base", pillar: "knowledge", tier: "view" },
  "article:write": {
    label: "Write & edit articles",
    pillar: "knowledge",
    tier: "edit",
  },
  "article:delete": {
    label: "Delete articles",
    pillar: "knowledge",
    tier: "delete",
  },
  // ── Manage ─────────────────────────────────────────────────────────────────
  "user:read": {
    label: "View the user directory",
    pillar: "manage",
    tier: "view",
  },
  "user:write": {
    // Like accessGrant:write, MEMBER holds it by the seed rule but user administration is gated on
    // the coarse `user:manage`; kept labeled for coverage, shown only in fine-tune.
    label: "Edit user records (reserved)",
    pillar: "manage",
    tier: "edit",
  },
  "user:delete": { label: "Delete users", pillar: "manage", tier: "delete" },
  "user:manage": {
    label: "Administer users",
    pillar: "manage",
    tier: "coarse",
  },
  "dashboard:read": { label: "View the dashboard", pillar: "manage", tier: "view" },
  "search:read": { label: "Use global search", pillar: "manage", tier: "view" },
  "logs:read": { label: "View activity logs", pillar: "manage", tier: "view" },
  "settings:read": { label: "View instance settings", pillar: "manage", tier: "view" },
  "settings:manage": {
    label: "Configure the instance",
    pillar: "manage",
    tier: "coarse",
  },
};

/**
 * The two tiers that are ABOVE every editable role's seed default. A role's default (MEMBER =
 * reads+writes, VIEWER = reads) never holds a `delete` or a `coarse` verb, so toggling one of these
 * onto MEMBER/VIEWER is an admin-level escalation the UI must warn about. `view`/`edit` are
 * within-tier and save without a warning.
 */
export const ABOVE_DEFAULT_TIERS: readonly PermissionTier[] = ["delete", "coarse"];

/** True when granting `permission` to a non-ADMIN role exceeds that role's seed default tier. */
export function isAboveDefaultTier(permission: Permission): boolean {
  return ABOVE_DEFAULT_TIERS.includes(PERMISSION_META[permission].tier);
}

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Capabilities — the operator-facing toggles. A capability bundles one or more catalog permissions
 * under a single plain-language label so an admin reasons in outcomes ("Add & edit inventory") rather
 * than `domain:action` literals. The fine-tune (advanced) view still exposes the raw permissions for
 * exact control; capabilities are the friendly default. A capability is "above default tier" if ANY
 * of its permissions is — those render the ⚠ admin-level marker and route through the consequential
 * confirm on save.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** A stable identifier for a capability (used as a React key and for preset definitions). */
export const CAPABILITY_IDS = [
  // Inventory
  "inventory.view",
  "inventory.edit",
  "inventory.delete",
  // Access
  "application.view",
  "application.edit",
  "application.delete",
  "accessGrant.view",
  "accessGrant.grant",
  // Knowledge
  "article.view",
  "article.edit",
  "article.delete",
  // Manage
  "user.view",
  "user.manage",
  "user.delete",
  "dashboardSearch.view",
  "logs.view",
  "settings.view",
  "settings.manage",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** A human capability toggle: a label, its pillar, and the catalog permissions it grants together. */
export interface Capability {
  readonly id: CapabilityId;
  /** Plain-language label rendered as the toggle's title. */
  readonly label: string;
  /** One-line clarifier under the label (what enabling it actually allows). */
  readonly description: string;
  readonly pillar: PermissionPillar;
  /** The catalog permissions this capability toggles on/off together. */
  readonly permissions: readonly Permission[];
}

/**
 * The capability map: the toggles the role config screen renders, in display order, grouped by pillar
 * downstream. Each bundles the permissions that move together for a human decision. "Inventory"
 * coalesces the five inventory domains so an admin grants "edit inventory" once instead of toggling
 * asset/consumable/model/category/location writes individually (the fine-tune view still allows
 * per-domain control). Access, Knowledge and the Manage coarse verbs stay per-domain because they are
 * distinct, consequential decisions.
 */
export const CAPABILITIES: readonly Capability[] = [
  // ── Inventory ──────────────────────────────────────────────────────────────
  {
    id: "inventory.view",
    label: "View inventory",
    description: "See assets, consumables, models, categories and locations.",
    pillar: "inventory",
    permissions: [
      "asset:read",
      "consumable:read",
      "assetModel:read",
      "category:read",
      "location:read",
    ],
  },
  {
    id: "inventory.edit",
    label: "Add & edit inventory",
    description:
      "Create and update assets, consumables, models, categories and locations (incl. stock adjustments).",
    pillar: "inventory",
    permissions: [
      "asset:write",
      "consumable:write",
      "assetModel:write",
      "category:write",
      "location:write",
    ],
  },
  {
    id: "inventory.delete",
    label: "Delete inventory",
    description:
      "Archive assets, consumables, models, categories and locations.",
    pillar: "inventory",
    permissions: [
      "asset:delete",
      "consumable:delete",
      "assetModel:delete",
      "category:delete",
      "location:delete",
    ],
  },
  // ── Access ─────────────────────────────────────────────────────────────────
  {
    id: "application.view",
    label: "View applications",
    description: "Browse the application catalog.",
    pillar: "access",
    permissions: ["application:read"],
  },
  {
    id: "application.edit",
    label: "Add & edit applications",
    description: "Create and update applications.",
    pillar: "access",
    permissions: ["application:write"],
  },
  {
    id: "application.delete",
    label: "Delete applications",
    description: "Archive applications.",
    pillar: "access",
    permissions: ["application:delete"],
  },
  {
    id: "accessGrant.view",
    label: "See who has access",
    description:
      "View the access-grant ledger — who can access which applications.",
    pillar: "access",
    permissions: ["accessGrant:read"],
  },
  {
    id: "accessGrant.grant",
    label: "Grant & revoke access",
    description:
      "Open, revoke and edit access grants for any user — including to sensitive applications.",
    pillar: "access",
    permissions: ["accessGrant:grant"],
  },
  // ── Knowledge ──────────────────────────────────────────────────────────────
  {
    id: "article.view",
    label: "Read the Knowledge Base",
    description: "View articles and their categories.",
    pillar: "knowledge",
    permissions: ["article:read"],
  },
  {
    id: "article.edit",
    label: "Write & edit articles",
    description: "Create, update and publish Knowledge Base articles.",
    pillar: "knowledge",
    permissions: ["article:write"],
  },
  {
    id: "article.delete",
    label: "Delete articles",
    description: "Archive Knowledge Base articles.",
    pillar: "knowledge",
    permissions: ["article:delete"],
  },
  // ── Manage ─────────────────────────────────────────────────────────────────
  {
    id: "user.view",
    label: "View the user directory",
    description: "Browse the list of users (names, emails, roles).",
    pillar: "manage",
    permissions: ["user:read"],
  },
  {
    id: "user.manage",
    label: "Administer users",
    description: "Create, edit, change roles, offboard and restore users.",
    pillar: "manage",
    permissions: ["user:manage"],
  },
  {
    id: "user.delete",
    label: "Delete users",
    description: "Permanently-style removal of user records.",
    pillar: "manage",
    permissions: ["user:delete"],
  },
  {
    id: "dashboardSearch.view",
    label: "View dashboard & search",
    description: "See the dashboard and use global search.",
    pillar: "manage",
    permissions: ["dashboard:read", "search:read"],
  },
  {
    id: "logs.view",
    label: "View activity logs",
    description: "See the estate-wide activity history (Reports/Informes).",
    pillar: "manage",
    permissions: ["logs:read"],
  },
  {
    id: "settings.view",
    label: "View instance settings",
    description: "See the settings area (instance configuration, taxonomies).",
    pillar: "manage",
    permissions: ["settings:read"],
  },
  {
    id: "settings.manage",
    label: "Configure the instance",
    description:
      "Change instance settings and manage taxonomies — the full admin configuration surface.",
    pillar: "manage",
    permissions: ["settings:manage"],
  },
];

/** Quick lookup of a capability by id. */
export const CAPABILITY_BY_ID: Record<CapabilityId, Capability> =
  Object.fromEntries(CAPABILITIES.map((c) => [c.id, c])) as Record<
    CapabilityId,
    Capability
  >;

/** True when ANY of a capability's permissions is above the editable role's seed default tier. */
export function capabilityIsAboveDefaultTier(capability: Capability): boolean {
  return capability.permissions.some(isAboveDefaultTier);
}

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Presets — named, ready-made permission bundles an admin can stage with one click. Each is a full
 * Permission[] (the complete desired set for an editable role), so applying a preset replaces the
 * whole staged set. "Custom" is not a preset — it is the state the UI shows when the staged set
 * matches no named preset (after a manual edit).
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
export const PRESET_IDS = ["editor", "readOnly", "inventoryOperator"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface PermissionPreset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  /** The complete permission set this preset stages (catalog literals). */
  readonly permissions: readonly Permission[];
}

/** Every `:read` literal — the read surface of all twelve domains (mirrors the seed's read tier). */
const READS = PERMISSIONS.filter((p) => p.endsWith(":read"));
/** The inventory pillar's write literals (for the inventory-operator preset). */
const INVENTORY_WRITES = PERMISSIONS.filter(
  (p) => PERMISSION_META[p].pillar === "inventory" && p.endsWith(":write"),
);

/**
 * The named presets. `editor` and `readOnly` mirror the MEMBER and VIEWER seed defaults
 * (`buildDefaultRolePermissions`) exactly, so "Editor" / "Read-only" round-trip with Reset to
 * defaults. `inventoryOperator` is read/write on Inventory + read everywhere else — the warehouse-y
 * role that can change stock but only look at Access/Knowledge/Manage.
 */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: "editor",
    label: "Editor",
    description: "Read and edit everything except deletes and admin actions.",
    // === MEMBER seed default: all reads + all writes.
    permissions: buildDefaultRolePermissions().MEMBER,
  },
  {
    id: "readOnly",
    label: "Read-only",
    description: "View access across the app (no edits).",
    // === VIEWER seed default: all reads except the two pre-tightened sensitive reads.
    permissions: buildDefaultRolePermissions().VIEWER,
  },
  {
    id: "inventoryOperator",
    label: "Inventory operator",
    description:
      "Read and edit Inventory; view-only on Access, Knowledge and Manage.",
    permissions: [
      // every read EXCEPT the pre-tightened sensitive reads AND the admin-only reads (logs:read) —
      // matches the read-only / VIEWER baseline so the inventory operator never leaks an admin-only read.
      ...READS.filter(
        (p) =>
          p !== "accessGrant:read" &&
          p !== "user:read" &&
          !ADMIN_ONLY_READS.includes(p as (typeof ADMIN_ONLY_READS)[number]),
      ),
      ...INVENTORY_WRITES,
    ],
  },
];

/** Quick lookup of a preset by id. */
export const PRESET_BY_ID: Record<PresetId, PermissionPreset> =
  Object.fromEntries(PERMISSION_PRESETS.map((p) => [p.id, p])) as Record<
    PresetId,
    PermissionPreset
  >;

/**
 * Normalize a permission set to a stable, comparable form (deduped, catalog-ordered). Two sets are
 * "the same" iff their normalized arrays are equal — the basis for "does the staged set match a
 * preset / the seed default?" comparisons in the UI.
 */
export function normalizePermissionSet(
  perms: readonly Permission[],
): Permission[] {
  const order = (p: Permission) => PERMISSIONS.indexOf(p);
  return [...new Set(perms)].sort((a, b) => order(a) - order(b));
}

/** True iff two permission sets contain exactly the same permissions (order-independent). */
export function permissionSetsEqual(
  a: readonly Permission[],
  b: readonly Permission[],
): boolean {
  const na = normalizePermissionSet(a);
  const nb = normalizePermissionSet(b);
  return na.length === nb.length && na.every((p, i) => p === nb[i]);
}
