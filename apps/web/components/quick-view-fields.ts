import type {
  Application,
  AssetListItem,
  AssetModel,
  InfraNodeKind,
  InfraNodeStatus,
  Location,
  UserListItem,
} from "@lazyit/shared";
import { isSafeApplicationUrl } from "@lazyit/shared";

/**
 * Quick View — the PURE presenter (no React, no i18n) so it is unit-testable in isolation
 * (`quick-view-fields.test.ts`). The {@link QuickViewPopover} component renders what these return.
 * ADR-0072: Quick View reads the row the picker ALREADY loaded (zero extra fetch) and never emits a
 * secret value (INV-10) — there are no secret fields here at all.
 */

/** The entities a Quick View can render. A superset of the global-search `SearchEntity` (it adds
 *  asset-model, consumable and category — picker rows the palette doesn't index). */
export type QuickViewEntity =
  | "asset"
  | "user"
  | "assetModel"
  | "application"
  | "location"
  | "article"
  | "consumable"
  | "category"
  | "infra";

/** A plain `<dl>` field: a localized label key (under `common.quickView.fields`) and its value. A
 *  `null`/empty value is dropped by {@link selectFields} so the grid never shows a dangling label. */
export interface QuickViewField {
  /** Key under `common.quickView.fields.*`. */
  labelKey: string;
  /** The display value (always present — empty values are dropped by {@link selectFields}). */
  value: string;
  /** When true, render the value monospaced (serials, asset tags, SKUs). */
  mono?: boolean;
}

/** The narrowed row shapes Quick View renders — the already-loaded picker rows. `article`/`consumable`/
 *  `category` aren't single-select picker entities in wave 1 but the presenter supports them for the
 *  multi-select / palette waves (#790/#791). */
export type QuickViewData =
  | { entity: "asset"; data: AssetListItem }
  | { entity: "user"; data: UserListItem }
  | { entity: "assetModel"; data: AssetModel }
  | { entity: "application"; data: Application }
  | { entity: "location"; data: Location }
  | {
      entity: "article";
      data: {
        id: string;
        title: string;
        slug: string;
        status: "DRAFT" | "PUBLISHED";
        categoryName?: string | null;
        excerpt?: string | null;
      };
    }
  | {
      entity: "consumable";
      data: {
        id: string;
        name: string;
        sku?: string | null;
        currentStock?: number | null;
        unit?: string | null;
        categoryName?: string | null;
        description?: string | null;
      };
    }
  | {
      entity: "category";
      data: { id: string; name: string; description?: string | null };
    }
  | {
      // An infra topology node (ADR-0070). Used by the global command palette (#791): the basics
      // (kind/status/linked asset/IP) come straight from the lean `InfraNodeHit` OR the already-loaded
      // `InfraNodeListItem` — zero extra fetch — with the drill-in (`useInfraNodeDetail`) only enriching
      // `assetName` when a palette hit lacks it. NEVER carries a secret value (INV-10): v1 has no
      // asset→secret linkage so there is no secrets field here at all.
      entity: "infra";
      data: {
        id: string;
        label: string;
        kind: InfraNodeKind;
        status: InfraNodeStatus;
        ipAddress?: string | null;
        assetName?: string | null;
      };
    };

/** The identity title shown in the header row (and announced via `aria-labelledby`). */
export function titleFor(view: QuickViewData): string {
  switch (view.entity) {
    case "user":
      return `${view.data.firstName} ${view.data.lastName}`.trim();
    case "assetModel":
      return `${view.data.manufacturer} ${view.data.name}`.trim();
    case "article":
      return view.data.title;
    case "infra":
      return view.data.label;
    default:
      return view.data.name;
  }
}

/** The pinned-footer deep-link, or `null` when the entity has no standalone detail route (asset models
 *  live under Settings → Taxonomies; categories/consumables likewise have no `/[id]` page). */
export function detailHref(view: QuickViewData): string | null {
  switch (view.entity) {
    case "asset":
      return `/assets/${view.data.id}`;
    case "user":
      return `/users/${view.data.id}`;
    case "application":
      return `/applications/${view.data.id}`;
    case "location":
      return `/locations/${view.data.id}`;
    case "article":
      return `/kb/${view.data.slug}`;
    case "infra":
      // No standalone detail page — the proven canvas deep-link selects + focuses the node (issue #765).
      return `/assets/diagram?node=${view.data.id}&focus=1`;
    default:
      // assetModel / consumable / category have no own detail route.
      return null;
  }
}

/**
 * Localized strings the pure presenter can't produce itself (it has no translator). Threaded in by the
 * component from `common.quickView.*`; the asset OWNER field needs them so the presenter stays pure and
 * unit-testable (the test passes plain functions). Optional: omit them and the owner field is dropped
 * rather than rendered untranslated.
 */
export interface QuickViewLabels {
  /** "Unassigned" — shown as the asset owner value when the asset has no active owner. */
  noOwner: string;
  /** "+{n} more" — suffix appended after the first owner when an asset has multiple active owners. */
  moreOwners: (count: number) => string;
  /** Localizes an infra node's `kind` enum (e.g. `PHYSICAL_HOST` → "Physical host", from the `infra`
   *  namespace). Optional: omit it and the infra `kind` field renders the raw enum value rather than a
   *  localized one (keeps the presenter translator-free + unit-testable). */
  infraKind?: (kind: InfraNodeKind) => string;
}

/**
 * PURE field selector (ADR-0072, unit-tested). Maps an entity row to the ordered `<dl>` body — only
 * the plain label/value fields; the identity title + status/role badge are rendered separately by the
 * component. Returns ONLY fields with a present value, in the per-entity order from the design brief.
 * Never emits a secret value (INV-10). An Application `url` is gated by {@link isSafeApplicationUrl}
 * (SEC-008) and rendered as plain text by the component (never a link href). The optional
 * {@link QuickViewLabels} supply the localized strings the asset OWNER field needs (so the function
 * stays translator-free and testable).
 */
export function selectFields(
  view: QuickViewData,
  labels?: QuickViewLabels,
): QuickViewField[] {
  const fields: QuickViewField[] = [];
  const push = (
    labelKey: string,
    value: string | null | undefined,
    mono = false,
  ) => {
    if (value !== null && value !== undefined && value !== "") {
      fields.push({ labelKey, value, mono });
    }
  };

  switch (view.entity) {
    case "asset": {
      const a = view.data;
      push("serial", a.serial, true);
      push("assetTag", a.assetTag, true);
      push(
        "model",
        a.model ? `${a.model.manufacturer} ${a.model.name}`.trim() : null,
      );
      push("category", a.model?.category?.name ?? null);
      push("location", a.location?.name ?? null);
      // Owner — the CEO's headline disambiguator ("which laptop? Ana's"). Already on the loaded row
      // as activeAssignments[].user (zero extra fetch). First owner "First Last" + "+N more" when
      // several; the localized "Unassigned" when none. Needs the translated labels, so it is skipped
      // when they aren't supplied (e.g. a non-localized caller / a bare test of the other fields).
      if (labels) {
        push("owner", formatOwners(a.activeAssignments, labels));
      }
      break;
    }
    case "user": {
      const u = view.data;
      push("email", u.email);
      push("username", u.username);
      push("legajo", u.legajo);
      // Directory attributes (ADR-0069 REDESIGN §3): department / job title live in the unvalidated
      // `directoryAttrs` jsonb (the importer routes them under exactly these keys). They are the
      // "may-or-may-not-exist" identity context the CEO wants — read defensively (the jsonb is per-field
      // unvalidated) and dropped by `push` when absent or not a non-empty string.
      push("department", directoryAttr(u.directoryAttrs, "department"));
      push("jobTitle", directoryAttr(u.directoryAttrs, "jobTitle"));
      push(
        "manager",
        u.manager
          ? u.manager.type === "user"
            ? `${u.manager.firstName} ${u.manager.lastName}`.trim()
            : u.manager.name
          : null,
      );
      push(
        "assets",
        u.assetsInPossession !== undefined ? String(u.assetsInPossession) : null,
      );
      push("apps", u.appAccesses !== undefined ? String(u.appAccesses) : null);
      break;
    }
    case "assetModel": {
      const m = view.data;
      push("manufacturer", m.manufacturer);
      push("sku", m.sku, true);
      push("description", m.description);
      break;
    }
    case "application": {
      const app = view.data;
      push("vendor", app.vendor);
      // SEC-008: only a safe-scheme url is shown, and as PLAIN TEXT (never a link href here).
      push("url", app.url && isSafeApplicationUrl(app.url) ? app.url : null);
      push("description", app.description);
      break;
    }
    case "location": {
      const l = view.data;
      push("address", l.address);
      push("floor", l.floor);
      push("description", l.description);
      break;
    }
    case "article": {
      const ar = view.data;
      push("slug", ar.slug, true);
      push("category", ar.categoryName ?? null);
      push("excerpt", ar.excerpt ?? null);
      break;
    }
    case "consumable": {
      const c = view.data;
      push("sku", c.sku ?? null, true);
      push("category", c.categoryName ?? null);
      push("description", c.description ?? null);
      break;
    }
    case "category": {
      push("description", view.data.description ?? null);
      break;
    }
    case "infra": {
      const n = view.data;
      // status is the identity badge (like asset/location/article), so it isn't a <dl> field here.
      // kind is localized via the threaded `infraKind` label; the raw enum is the translator-free
      // fallback (the unit test relies on it). linked asset + IP are the other quick disambiguators.
      push("kind", labels?.infraKind ? labels.infraKind(n.kind) : n.kind);
      push("linkedAsset", n.assetName ?? null);
      push("ip", n.ipAddress ?? null, true);
      break;
    }
  }
  return fields;
}

/**
 * The asset OWNER value from its active assignments (ADR-0019: ownership is the active-assignment join,
 * never a column). The first owner's "First Last", plus a localized "+N more" suffix when several;
 * the localized "Unassigned" when there are none. Reads only the already-loaded
 * `AssetListItem.activeAssignments` (zero extra fetch). Exported for the unit test.
 */
export function formatOwners(
  assignments: AssetListItem["activeAssignments"],
  labels: QuickViewLabels,
): string {
  if (assignments.length === 0) return labels.noOwner;
  const first = assignments[0]!.user;
  const name = `${first.firstName} ${first.lastName}`.trim();
  const extra = assignments.length - 1;
  return extra > 0 ? `${name} ${labels.moreOwners(extra)}` : name;
}

/**
 * Read one directory attribute (ADR-0069 REDESIGN §3) from the unvalidated `directoryAttrs` jsonb.
 * The bag is `Record<string, unknown> | null | undefined` (per-field unvalidated, like Asset.specs),
 * so it is read defensively: only a non-empty string value is returned — anything else (missing key,
 * null, a non-string) yields `null`, which {@link selectFields}'s `push` then drops. Exported for the
 * unit test.
 */
export function directoryAttr(
  attrs: UserListItem["directoryAttrs"],
  key: string,
): string | null {
  const value = attrs?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The set of field keys whose value is long enough to span the full grid width. */
export const FULL_WIDTH_FIELDS = new Set([
  "url",
  "address",
  "description",
  "excerpt",
]);
