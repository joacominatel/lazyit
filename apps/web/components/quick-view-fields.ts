import type {
  Application,
  AssetListItem,
  AssetModel,
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
  | "category";

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
    default:
      // assetModel / consumable / category have no own detail route.
      return null;
  }
}

/**
 * PURE field selector (ADR-0072, unit-tested). Maps an entity row to the ordered `<dl>` body — only
 * the plain label/value fields; the identity title + status/role badge are rendered separately by the
 * component. Returns ONLY fields with a present value, in the per-entity order from the design brief.
 * Never emits a secret value (INV-10). An Application `url` is gated by {@link isSafeApplicationUrl}
 * (SEC-008) and rendered as plain text by the component (never a link href).
 */
export function selectFields(view: QuickViewData): QuickViewField[] {
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
      break;
    }
    case "user": {
      const u = view.data;
      push("email", u.email);
      push("username", u.username);
      push("legajo", u.legajo);
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
  }
  return fields;
}

/** The set of field keys whose value is long enough to span the full grid width. */
export const FULL_WIDTH_FIELDS = new Set([
  "url",
  "address",
  "description",
  "excerpt",
]);
