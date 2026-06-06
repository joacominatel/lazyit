/**
 * Clone sanitizers — pure mappers that turn a persisted record into a `CreateX`-shaped partial,
 * ready to PRE-FILL the existing create form ("Clone" a record). A clone is just a normal create
 * body: it rides the existing POST endpoints, which already enforce the partial-unique indexes and
 * the soft-delete contract. These functions live here (the canonical place for web↔api logic) so
 * both the form pre-fill and its unit tests share one definition.
 *
 * Why a hand-written mapper per entity instead of a blind spread:
 *  - **Unique fields must be CLEARED** so the create doesn't 409 on a duplicate index (and so the
 *    operator notices an empty field they must fill): `Asset.serial`/`Asset.assetTag`,
 *    `Consumable.sku`, `AssetModel.sku`. A category's unique `name` is suffixed " (copy)" instead.
 *  - **Server-owned / sensitive fields must be OMITTED** — most importantly on `User`:
 *    `externalId` is never copied (CreateUserSchema rejects it — SEC-006) and `role` is OMITTED so
 *    the server applies its default VIEWER (least privilege — never carry ADMIN/MEMBER from the
 *    source). `email` is cleared to "" to force a fresh, unique address. A naive copy-all here would
 *    be a privilege-escalation bug.
 *  - **jsonb is DEEP-COPIED** (`structuredClone`) so the clone's `specs` / `metadata` never aliases
 *    the source object.
 *  - id / timestamps / owner / assignments / stock / movements are never part of a create payload,
 *    so they simply aren't mapped.
 *
 * Each mapper returns a `Partial<CreateX>`: the form merges it onto its create defaults and submits
 * through the normal create flow (so server 409 / validation surfaces exactly as for a fresh create).
 *
 * See docs/03-decisions/0020-frontend-data-layer.md (the create-form mold this pre-fills) and the
 * per-entity Create schemas in the sibling schemas/.
 */

import type { Application } from "../schemas/application";
import type { ApplicationCategory } from "../schemas/application-category";
import type { ArticleCategory } from "../schemas/article-category";
import type { Asset } from "../schemas/asset";
import type { AssetCategory } from "../schemas/asset-category";
import type { AssetModel } from "../schemas/asset-model";
import type { Consumable } from "../schemas/consumable";
import type { ConsumableCategory } from "../schemas/consumable-category";

/** The " (copy)" suffix appended to a cloned record's name so the duplicate is obvious. */
export const CLONE_NAME_SUFFIX = " (copy)";

/** Append the clone suffix to a name (e.g. "Ada's laptop" → "Ada's laptop (copy)"). */
export function withCopySuffix(name: string): string {
  return `${name}${CLONE_NAME_SUFFIX}`;
}

// `structuredClone` is a runtime global in both Bun and the Next.js/Node web runtime, but the
// leaf shared package compiles with `lib: ["ES2023"]` / `types: []` (no DOM, no @types/node), so
// the global isn't declared. Declare just this one signature locally rather than pull a whole lib.
declare const structuredClone: <T>(value: T) => T;

/** `null` → `undefined`, so a nullable persisted field maps onto an optional create field. */
function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * Deep-copy a jsonb blob (`specs` / `metadata`) so the clone never aliases the source object;
 * `null`/`undefined` map to `undefined` (the create field is optional, not nullable).
 */
function cloneJson<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : structuredClone(value);
}

export function applyAssetModelSpecsDefaults(
  modelSpecs: Record<string, unknown> | null | undefined,
  assetSpecs: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const defaults = cloneJson(modelSpecs);
  const overrides = cloneJson(assetSpecs);
  if (defaults === undefined) return overrides;
  if (overrides === undefined) return defaults;
  return { ...defaults, ...overrides };
}

/**
 * The `CreateAsset`-shaped partial for cloning an Asset. Copies the descriptive + classification
 * fields, DEEP-COPIES `specs`, and CLEARS the unique partial-index fields `serial` / `assetTag` (so
 * the create can't 409 and the operator re-enters them). Owner/assignment/history aren't part of a
 * create payload, so they're absent.
 */
export function cloneAssetDefaults(source: Asset): Partial<{
  name: string;
  serial: string | undefined;
  assetTag: string | undefined;
  status: Asset["status"];
  specs: Record<string, unknown> | undefined;
  notes: string | undefined;
  purchaseDate: string | undefined;
  warrantyEnd: string | undefined;
  modelId: string | undefined;
  locationId: string | undefined;
}> {
  return {
    name: withCopySuffix(source.name),
    status: source.status,
    modelId: orUndefined(source.modelId),
    locationId: orUndefined(source.locationId),
    notes: orUndefined(source.notes),
    purchaseDate: orUndefined(source.purchaseDate),
    warrantyEnd: orUndefined(source.warrantyEnd),
    specs: cloneJson(source.specs),
    // Unique partial-index fields — cleared so the create can't collide and the operator notices.
    serial: undefined,
    assetTag: undefined,
  };
}

/**
 * The `CreateConsumable`-shaped partial for cloning a Consumable. Copies the descriptive fields and
 * CLEARS the unique `sku`. `currentStock` is not part of a create payload (it starts at 0 via
 * ADR-0034 and only changes through movements), and movements are never copied.
 */
export function cloneConsumableDefaults(source: Consumable): Partial<{
  name: string;
  sku: string | undefined;
  categoryId: string | undefined;
  description: string | undefined;
  minStock: number | undefined;
  unit: string;
  notes: string | undefined;
}> {
  return {
    name: withCopySuffix(source.name),
    categoryId: orUndefined(source.categoryId),
    description: orUndefined(source.description),
    minStock: orUndefined(source.minStock),
    unit: source.unit,
    notes: orUndefined(source.notes),
    // Unique field — cleared.
    sku: undefined,
  };
}

/**
 * The `CreateApplication`-shaped partial for cloning an Application. Copies the descriptive +
 * classification fields and DEEP-COPIES `metadata`. There's no unique business field; the `url` is
 * carried verbatim — the create resolver re-validates it against `isSafeApplicationUrl` (SEC-008),
 * which a stored, already-safe url passes.
 */
export function cloneApplicationDefaults(source: Application): Partial<{
  name: string;
  description: string | undefined;
  url: string | undefined;
  vendor: string | undefined;
  categoryId: string | undefined;
  isCritical: boolean;
  metadata: Record<string, unknown> | undefined;
  notes: string | undefined;
}> {
  return {
    name: withCopySuffix(source.name),
    description: orUndefined(source.description),
    url: orUndefined(source.url),
    vendor: orUndefined(source.vendor),
    categoryId: orUndefined(source.categoryId),
    isCritical: source.isCritical,
    metadata: cloneJson(source.metadata),
    notes: orUndefined(source.notes),
  };
}

/**
 * The `CreateAssetModel`-shaped partial for cloning an AssetModel. Copies name (+suffix),
 * manufacturer, description and the owning category, DEEP-COPIES `specs`, and CLEARS the unique
 * `sku`.
 */
export function cloneAssetModelDefaults(source: AssetModel): Partial<{
  name: string;
  manufacturer: string;
  sku: string | undefined;
  description: string | undefined;
  specs: Record<string, unknown> | undefined;
  categoryId: string | undefined;
}> {
  return {
    name: withCopySuffix(source.name),
    manufacturer: source.manufacturer,
    description: orUndefined(source.description),
    categoryId: orUndefined(source.categoryId),
    specs: cloneJson(source.specs),
    // Unique field — cleared.
    sku: undefined,
  };
}

/**
 * The create-shaped partial for cloning any of the four category kinds. The only UNIQUE field is
 * `name`, suffixed " (copy)"; the non-unique descriptive fields (`description` / `icon`, plus the
 * `order` sort key on the kinds that have one) are carried so the clone is a genuine starting point.
 * Asset categories have no `order`; the others do — both shapes are accepted and `order` is mapped
 * only when the source carries it.
 */
export function cloneCategoryDefaults(
  source:
    | AssetCategory
    | ApplicationCategory
    | ConsumableCategory
    | ArticleCategory,
): Partial<{
  name: string;
  description: string | undefined;
  icon: string | undefined;
  order: number | undefined;
}> {
  const base: {
    name: string;
    description: string | undefined;
    icon: string | undefined;
    order?: number | undefined;
  } = {
    name: withCopySuffix(source.name),
    description: orUndefined(source.description),
    icon: orUndefined(source.icon),
  };
  // Only the application/consumable/article kinds carry an `order`; asset categories don't.
  if ("order" in source) base.order = orUndefined(source.order);
  return base;
}

/**
 * The `CreateUser`-shaped partial for cloning a User — SECURITY-SENSITIVE, deliberately minimal.
 * Copies ONLY `firstName` / `lastName`. `email` is cleared to "" (force a new, unique address —
 * never auto-suffix an email). `externalId` is NEVER copied (CreateUserSchema rejects it — SEC-006).
 * `role` is OMITTED so the server applies its default VIEWER (least privilege): a clone must NOT
 * carry ADMIN/MEMBER from the source. `isActive` / id / timestamps are not part of a create payload.
 */
export function cloneUserDefaults(source: {
  firstName: string;
  lastName: string;
}): { firstName: string; lastName: string; email: string } {
  return {
    firstName: source.firstName,
    lastName: source.lastName,
    // Forced empty so the operator must supply a fresh, unique address.
    email: "",
    // role is intentionally OMITTED (→ server default VIEWER). externalId is never set.
  };
}
