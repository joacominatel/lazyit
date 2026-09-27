import type { AiEntityType, AiPageContext } from "@lazyit/shared";

/**
 * The page the user is on → the `context` a chat message carries (frontend.md §11 item 7; security.md
 * T-39). Only the route and at most one entity ref — never page content. It is the inverse of
 * `entity-href.ts` for the pages that show a single entity.
 *
 * Collection sub-routes (`/assets/new`, `/assets/diagram`, …) are not entities; ids are accepted only
 * when they look like an id (letters, digits, `-`, `_`), so nothing a URL carries reaches the API as an
 * entity id unless it could be one. Articles are routed by slug, which is not an id: the route alone
 * describes them.
 */

const ENTITY_ROUTES: readonly { prefix: string; type: AiEntityType }[] = [
  { prefix: "assets", type: "asset" },
  { prefix: "users", type: "user" },
  { prefix: "applications", type: "application" },
  { prefix: "locations", type: "location" },
  { prefix: "consumables", type: "consumable" },
];

/** Second segments that are pages of a collection, not an entity id. */
const RESERVED = new Set([
  "new",
  "diagram",
  "scan",
  "servers",
  "access-requests",
  "import",
  "imports",
]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** The context for `pathname`, or `null` for a path that is not an app route. */
export function routeContext(pathname: string | null | undefined): AiPageContext | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const route = pathname.split(/[?#]/, 1)[0]!.slice(0, 2048);
  if (route.length === 0) return null;

  const [first, second] = route.split("/").filter(Boolean);
  const match = ENTITY_ROUTES.find((entry) => entry.prefix === first);
  if (match && second && !RESERVED.has(second) && ID_PATTERN.test(second)) {
    return { route, entity: { type: match.type, id: second } };
  }
  return { route };
}
