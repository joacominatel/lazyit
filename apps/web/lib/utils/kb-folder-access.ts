import {
  type Folder,
  FolderAccessRulesSchema,
  type Role,
} from "@lazyit/shared";

/**
 * How a Knowledge Base folder's audience reads in the UI (ADR-0060, #1539) — the padlocks in the rail,
 * the list and the folder cards, and the "Who can see" fact on the folder header.
 *
 * Two signals exist on a folder read:
 *  - `accessRules` — the rule list itself, sent ONLY to a `settings:manage` caller (#554);
 *  - `hasAccessRules` — the derived "carries a restriction" bit, sent to every `category:read`
 *    caller (#1299). It says a restriction exists, never who it lets in.
 *
 * Both are presentation of a decision the server already made (INV-9); nothing here grants or refuses
 * anything. An absent bit on an older server is UNKNOWN, never public (the #1299 contract).
 */

/** The fields this module reads — a full `Folder` plus the admin-only `accessRules` satisfies it. */
export type FolderAccessInput = Pick<Folder, "id" | "parentId" | "hasAccessRules"> & {
  /** Present only for a `settings:manage` caller; `null` / `[]` mean public. */
  accessRules?: unknown;
};

/**
 * Whether the folder carries a restriction of its OWN: `true`, `false`, or `null` when the server did
 * not say (no flag and no rules — an older server answering a non-admin).
 */
export function ownRestriction(folder: FolderAccessInput): boolean | null {
  if (typeof folder.hasAccessRules === "boolean") return folder.hasAccessRules;
  if (Array.isArray(folder.accessRules)) return folder.accessRules.length > 0;
  if (folder.accessRules === null) return false;
  return null;
}

/** The ids of every folder that carries its own restriction. */
export function restrictedFolderIdSet(folders: readonly FolderAccessInput[]): Set<string> {
  const ids = new Set<string>();
  for (const folder of folders) {
    if (ownRestriction(folder) === true) ids.add(folder.id);
  }
  return ids;
}

/** One rule of a restricted folder, reduced to what the header sentence needs. */
export type AccessRulePart =
  | { kind: "role"; role: Role }
  | { kind: "users"; count: number }
  | { kind: "appGrant"; applicationId: string }
  | { kind: "assetAssignment"; assetId: string };

/** The "Who can see" verdict for a folder. */
export type FolderAccessSummary =
  /** Nothing on the path restricts: everyone who can read the Knowledge Base. */
  | { state: "public" }
  /**
   * The folder has its own rule. `parts` is filled only when the rules were sent (a `settings:manage`
   * caller); other viewers get an empty list and the header just says "Restricted".
   */
  | { state: "restricted"; parts: AccessRulePart[] }
  /** No rule of its own, but an ancestor restricts it. */
  | { state: "inherited"; ancestorId: string }
  /** The server did not say for some folder on the path (an older API). */
  | { state: "unknown" };

/**
 * Reduce a rule list to header parts: one part per role / app / asset rule, and every `users` rule
 * merged into a single distinct-person count. A malformed list yields no parts (the header then falls
 * back to the plain "Restricted"), never a crash.
 */
export function accessRuleParts(rawRules: unknown): AccessRulePart[] {
  const parsed = FolderAccessRulesSchema.safeParse(rawRules);
  if (!parsed.success || !parsed.data) return [];
  const parts: AccessRulePart[] = [];
  const userIds = new Set<string>();
  for (const rule of parsed.data) {
    switch (rule.kind) {
      case "users":
        for (const id of rule.userIds) userIds.add(id);
        break;
      case "role":
        parts.push({ kind: "role", role: rule.role });
        break;
      case "appGrant":
        parts.push({ kind: "appGrant", applicationId: rule.applicationId });
        break;
      case "assetAssignment":
        parts.push({ kind: "assetAssignment", assetId: rule.assetId });
        break;
    }
  }
  if (userIds.size > 0) parts.unshift({ kind: "users", count: userIds.size });
  return parts;
}

/**
 * The "Who can see" verdict for `folderId`: its own rule wins; else the nearest restricted ancestor;
 * else public — but only when every folder on the path gave an answer. A missing folder or a malformed
 * `parentId` cycle ends the walk.
 */
export function summarizeFolderAccess(
  folderId: string,
  folders: readonly FolderAccessInput[],
): FolderAccessSummary {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const folder = byId.get(folderId);
  if (!folder) return { state: "unknown" };

  const own = ownRestriction(folder);
  if (own === true) {
    return { state: "restricted", parts: accessRuleParts(folder.accessRules) };
  }

  let unknown = own === null;
  const seen = new Set<string>([folder.id]);
  let cursor = folder.parentId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const ancestor = byId.get(cursor);
    if (!ancestor) break;
    const restricted = ownRestriction(ancestor);
    if (restricted === true) return { state: "inherited", ancestorId: ancestor.id };
    if (restricted === null) unknown = true;
    cursor = ancestor.parentId ?? null;
  }
  return unknown ? { state: "unknown" } : { state: "public" };
}
