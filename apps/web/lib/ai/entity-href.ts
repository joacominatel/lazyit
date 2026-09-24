import type { AiEntityRef, AiEntityType } from "@lazyit/shared";
import { safeInternalPath } from "@/lib/utils/safe-redirect";

/**
 * Entity ref → internal route (docs/ai-assistant/tools-and-execution.md §8.5, frontend.md Fork D). The
 * API never sends an `href`: the web builds every link from `{ type, id, slug?, parent? }`, so a model or
 * a tool cannot plant an open redirect or a `javascript:` sink in the chat.
 *
 * Every segment is URL-encoded, and the result is re-checked with `safeInternalPath`: anything that is
 * not a same-origin relative path yields `null` (no link) instead of a fallback page.
 */

/** The part of a ref the route needs. `parent` points at the page an entity without its own lives on. */
export interface EntityPointer {
  type: AiEntityType | string;
  id: string;
  slug?: string;
  parent?: { type: AiEntityType | string; id: string; slug?: string };
}

const seg = (value: string) => encodeURIComponent(value);

/** The route of an entity that has a page of its own, or `null`. */
function ownRoute(ref: { type: string; id: string; slug?: string }): string | null {
  switch (ref.type) {
    case "asset":
      return `/assets/${seg(ref.id)}`;
    case "user":
      return `/users/${seg(ref.id)}`;
    case "application":
      return `/applications/${seg(ref.id)}`;
    case "location":
      return `/locations/${seg(ref.id)}`;
    case "consumable":
      return `/consumables/${seg(ref.id)}`;
    case "article":
      // Articles are routed by slug; without one there is no page to open.
      return ref.slug ? `/kb/${seg(ref.slug)}` : null;
    case "infraNode":
      // No standalone page: the topology canvas selects and focuses the node (quick-view precedent).
      return `/assets/diagram?node=${seg(ref.id)}&focus=1`;
    case "manualTask":
      return `/settings/integrations/tasks/${seg(ref.id)}`;
    default:
      return null;
  }
}

function buildRoute(ref: EntityPointer): string | null {
  switch (ref.type) {
    case "workflowRun":
      return ref.parent?.type === "application"
        ? `/applications/${seg(ref.parent.id)}/workflows/runs/${seg(ref.id)}`
        : null;
    // Entities without a page open the page they live on.
    case "assetAssignment":
    case "accessGrant":
    case "consumableMovement":
      return ref.parent ? ownRoute(ref.parent) : null;
    case "accessRequest":
      return ref.parent ? ownRoute(ref.parent) : "/applications/access-requests";
    default:
      return ownRoute(ref);
  }
}

/**
 * The safe internal href for an entity ref, or `null` when the web has no page for it (an asset model, a
 * category, an infra edge, a type this build does not know, an article without a slug).
 */
export function entityHref(ref: EntityPointer): string | null {
  if (typeof ref?.id !== "string" || ref.id.length === 0) return null;
  const route = buildRoute(ref);
  if (route === null) return null;
  return safeInternalPath(route) === route ? route : null;
}

/** The refs of a result that the chat can link to, deduplicated by href (first label wins). */
export function linkableRefs(refs: readonly AiEntityRef[]): { ref: AiEntityRef; href: string }[] {
  const seen = new Set<string>();
  const out: { ref: AiEntityRef; href: string }[] = [];
  for (const ref of refs) {
    const href = entityHref(ref);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ ref, href });
  }
  return out;
}
