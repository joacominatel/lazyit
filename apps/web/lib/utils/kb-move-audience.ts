import type { Folder } from "@lazyit/shared";

/**
 * Does a Knowledge Base move change who can read the moved articles? (ADR-0060 §9, #1529)
 *
 * An article carries no access rule of its own: its home folder IS its rule, and the effective rule
 * is the AND of every restricted folder on the path from that folder up to the root (§1, inherit-and-
 * narrow). So a folder change is an authorization write, and the web asks for explicit consent before
 * a move that may let more people read a document. This module is the ONE place that decides whether
 * such a move needs that confirmation; every move surface routes through it.
 *
 * The only signal is the derived `hasAccessRules` bit on each folder read (#1299). One bit per folder
 * says WHICH folders restrict, never WHO they let in, so two restricted paths can only be compared as
 * sets of restricting folders. Every rule on a path must be passed (ADR-0060 §1), so a destination that
 * keeps every source restriction (the same set, or more) can only keep or narrow the audience; any
 * other restricted destination changes it in a direction the bit cannot tell.
 *
 * PRESENTATION ONLY. The server enforces access (INV-9) and decides the move (§9 refuses a blind
 * destination). Nothing here grants or refuses anything; it only chooses whether to ask first.
 */

/** The verdict for a move, from the moved articles' point of view. */
export type MoveAudienceChange =
  /** No folder change, a public source, or a destination that keeps every source restriction. */
  | "none"
  /** Restricted before, nothing restricts after: everyone who can read the KB will read it. */
  | "widens-to-public"
  /** Restricted on both sides, but the destination drops a source restriction: maybe widening. */
  | "changes-restriction"
  /** A folder on either path is missing, or lacks the flag (an older server): no verdict. */
  | "unknown";

/** The two verdicts that ask the user before saving. */
export type ConfirmableMoveAudienceChange = Extract<
  MoveAudienceChange,
  "widens-to-public" | "changes-restriction"
>;

/** The structural fields the classification reads — a full `Folder` satisfies it. */
export type FolderAccessShape = Pick<Folder, "id" | "parentId" | "hasAccessRules">;

/** True when the verdict asks for an explicit confirmation before the move is saved. */
export function needsMoveConfirmation(
  change: MoveAudienceChange,
): change is ConfirmableMoveAudienceChange {
  return change === "widens-to-public" || change === "changes-restriction";
}

/**
 * Classify moving an article from its home folder `sourceId` to `destId`.
 *
 * - same folder → `none` (not a move; §9 does not evaluate it either);
 * - either path unknown → `unknown`;
 * - public source → `none` (a move out of a public folder can only keep or narrow the audience);
 * - restricted source, public destination → `widens-to-public`;
 * - restricted on both sides by the same folders → `none`;
 * - restricted on both sides by different folders → `changes-restriction`.
 */
export function classifyArticleMove(
  sourceId: string,
  destId: string,
  folders: readonly FolderAccessShape[],
): MoveAudienceChange {
  if (sourceId === destId) return "none";
  const byId = indexFolders(folders);
  const before = walkRestriction(sourceId, byId);
  const after = walkRestriction(destId, byId);
  if (before === null || after === null) return "unknown";
  return compareRestriction(before.restricted, after.restricted);
}

/**
 * Classify re-parenting the folder `folderId` under `newParentId` (`null` = the top level).
 *
 * Every article in the moved subtree keeps the restricting folders INSIDE the subtree and swaps the
 * ones ABOVE it, so comparing the moved folder's own path before and after is exact for the whole
 * subtree: `none` means no article in it can gain readers, and `widens-to-public` means the moved
 * folder's own articles (and those of sub-folders without a rule of their own) become public.
 *
 * A destination inside the moved folder's own subtree is a cycle the API refuses (ADR-0059 §1); it
 * is classified `none` so the user is not asked to consent to a move that will not happen. The cycle
 * rule itself stays the server's — the refusal is still reported from the API's answer.
 */
export function classifyFolderMove(
  folderId: string,
  newParentId: string | null,
  folders: readonly FolderAccessShape[],
): MoveAudienceChange {
  const byId = indexFolders(folders);
  const folder = byId.get(folderId);
  if (!folder) return "unknown";
  if ((folder.parentId ?? null) === newParentId) return "none";

  const before = walkRestriction(folderId, byId);
  if (before === null || typeof folder.hasAccessRules !== "boolean") {
    return "unknown";
  }

  let parentRestricted: ReadonlySet<string> = new Set();
  if (newParentId !== null) {
    const parentWalk = walkRestriction(newParentId, byId);
    if (parentWalk === null) return "unknown";
    if (parentWalk.visited.has(folderId)) return "none";
    parentRestricted = parentWalk.restricted;
  }

  const after = new Set(parentRestricted);
  if (folder.hasAccessRules) after.add(folderId);
  return compareRestriction(before.restricted, after);
}

function indexFolders(
  folders: readonly FolderAccessShape[],
): Map<string, FolderAccessShape> {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

/**
 * Walk from `startId` up the `parentId` chain and collect every folder that carries a restriction.
 *
 * Returns `null` — UNKNOWN — when any folder on the path is missing from the list or lacks an explicit
 * boolean `hasAccessRules`. An absent flag means the server predates #1299, and the ADR is explicit
 * that absent is "unknown", never "public": treating it as public could tell the user a widening move
 * is safe, and treating it as restricted would raise a dialog asserting a change we cannot see. So
 * the caller skips the confirmation entirely rather than show a misleading one. A missing ancestor
 * (soft-deleted out from under its child) is likewise unknown — the server fails closed on it.
 *
 * A malformed `parentId` cycle stops the walk once every node in it has been visited.
 */
function walkRestriction(
  startId: string,
  byId: ReadonlyMap<string, FolderAccessShape>,
): { restricted: Set<string>; visited: Set<string> } | null {
  const restricted = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | null = startId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const folder = byId.get(cursor);
    if (!folder || typeof folder.hasAccessRules !== "boolean") return null;
    if (folder.hasAccessRules) restricted.add(folder.id);
    cursor = folder.parentId ?? null;
  }
  return { restricted, visited };
}

function compareRestriction(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): MoveAudienceChange {
  if (before.size === 0) return "none";
  if (after.size === 0) return "widens-to-public";
  // Every rule on the path must be passed (ADR-0060 §1: an ancestor narrows its whole subtree), so a
  // destination that keeps EVERY source restriction — the same set, or that set plus more — can only
  // keep or narrow the audience. Nothing to confirm.
  if ([...before].every((id) => after.has(id))) return "none";
  return "changes-restriction";
}
