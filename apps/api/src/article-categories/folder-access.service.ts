import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RoleSchema, type FolderAccessRule } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isServicePrincipal, type Principal } from '../auth/principal';

/**
 * A LENIENT structural re-parse of a folder's stored `accessRules` (ADR-0060 §3). The DTO edge already
 * validated the rule on WRITE against the strict `FolderAccessRulesSchema` (cuid/uuid formats and all);
 * on READ we only need the STRUCTURE (a known `kind` + its id/role shape) to evaluate it — re-enforcing
 * id FORMAT here would be brittle (a future id-format change would silently hide folders). So ids are
 * `z.string().min(1)` here, while `kind`/`role` stay strict (a corrupted/foreign value still fails →
 * the folder fails closed for non-admins, never silently goes PUBLIC). This is the read-time twin of
 * the strict write-time schema, deliberately format-agnostic.
 */
const StoredRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('users'),
    userIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({ kind: z.literal('role'), role: RoleSchema }),
  z.object({ kind: z.literal('appGrant'), applicationId: z.string().min(1) }),
  z.object({ kind: z.literal('assetAssignment'), assetId: z.string().min(1) }),
]);
const StoredRulesSchema = z.array(StoredRuleSchema);

/**
 * The set of folders a caller may see, OR the sentinel `'ALL'` for an ADMIN (§5) — the resolved output
 * of {@link FolderAccessService.visibleFolderIds}. A `Set<string>` is the explicit, finite set of live
 * folder ids the caller passes §4 folder access for; `'ALL'` short-circuits every folder check (ADMIN
 * sees everything, INV-8). Read it through {@link folderVisible}.
 */
export type VisibleFolders = 'ALL' | ReadonlySet<string>;

/**
 * A folder's identity + resolved restriction, the minimal row the inheritance walk needs.
 *
 * `isPublic` is the §2 fast-path flag (no rule → visible to any authenticated caller). `rules` is the
 * parsed OR-rule list — EMPTY when the folder is PUBLIC *or* when its stored value was malformed. The
 * two are kept distinct on purpose: a malformed restriction has `isPublic === false` + `rules === []`,
 * so it matches nobody (a non-admin is hidden) rather than silently going PUBLIC. Fail closed.
 */
interface FolderNode {
  id: string;
  parentId: string | null;
  isPublic: boolean;
  rules: FolderAccessRule[];
}

/**
 * A REQUEST-SCOPED memo for the folder-tree load (#599). A single mutable holder a caller creates ONCE
 * per request and threads through the {@link FolderAccessService.visibleFolderIds} calls of that request
 * (e.g. `findOne` + the list/backlinks call). When passed, the full `articleCategory.findMany` runs at
 * most once per request instead of per call. It memoizes ONLY the static folder TREE (id/parentId/rules)
 * — the caller's live joins (active grants / current assignments) are STILL resolved fresh on every call,
 * so a just-revoked grant or released asset drops access on the next read (zero staleness, ADR-0060 §3).
 *
 * Deliberately NOT a cross-request TTL cache: a fresh `{}` is created per request and discarded after it,
 * so there is no shared mutable state to drift between requests (that would need an ADR-0060 amendment).
 */
export interface FolderTreeCache {
  folders?: FolderNode[];
}

/** True iff a resolved {@link VisibleFolders} grants access to `folderId` (ADMIN `'ALL'` always does). */
export function folderVisible(
  visible: VisibleFolders,
  folderId: string,
): boolean {
  return visible === 'ALL' || visible.has(folderId);
}

/**
 * Folder access evaluator (ADR-0060 §4, DB-first; INV-9). Resolves WHICH folders a caller may read,
 * honouring:
 *
 *  - **§2 default PUBLIC** — a folder with no rule (`accessRules` null/empty) is visible to any
 *    authenticated caller (the capability `article:read` is checked separately by the route guard).
 *  - **§3 OR rules over LIVE joins** — a restricted folder is visible iff at least one of its rules
 *    matches the caller: an explicit user (`users`), the caller's `role`, an ACTIVE AccessGrant to an
 *    application (`appGrant`, `revokedAt IS NULL`), or a CURRENT AssetAssignment (`assetAssignment`,
 *    `releasedAt IS NULL`). The two dynamic kinds are resolved DB-first (the caller's active
 *    applicationIds / assetIds, honouring the soft-delete read filter), so access follows offboarding
 *    automatically — revoke the grant / release the asset and the next read drops it.
 *  - **§1 inherit-and-narrow** — a folder is visible iff the caller matches the OWN rule of every
 *    restricted folder on its ancestor path (self + ancestors). A restricted ancestor narrows its whole
 *    subtree; a child can narrow further but can NEVER widen past an ancestor (that would be an
 *    escalation, §6). Effective rule = own ∩ ancestors' restrictions.
 *  - **§5 ADMIN god-mode** — an ADMIN sees every folder (returns `'ALL'`).
 *  - **§8 service accounts fail closed** — an SA is not a folder-ACL subject (the rule kinds are all
 *    User-shaped); it matches NO restriction, so it sees only PUBLIC folders.
 *
 * The output is a {@link VisibleFolders} set consumed by the article read path (build a Prisma `where`
 * that pins `categoryId IN <visible>`, so a folder-hidden article simply isn't found → 404, never 403)
 * and by the search post-filter (drop hits whose home folder is not visible). It is recomputed per read
 * (never cached) — that is what makes the dynamic rules dynamic-by-construction (ADR-0060 §3).
 */
@Injectable()
export class FolderAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the caller's visible folder set (§4). Returns `'ALL'` for an ADMIN (§5). For a non-admin
   * human or a service account it returns the explicit Set of live folder ids the caller passes folder
   * access for. The PUBLIC fast-path keeps the all-public case to a single folder scan with no `EXISTS`
   * subquery (the common case pays nothing extra). The dynamic-rule lookups are skipped entirely unless
   * a restricted folder actually uses that rule kind.
   */
  async visibleFolderIds(
    principal?: Principal,
    cache?: FolderTreeCache,
  ): Promise<VisibleFolders> {
    // §5 ADMIN god-mode (INV-8): an ADMIN sees every folder — short-circuit, no per-folder evaluation.
    if (principal !== undefined && !isServicePrincipal(principal)) {
      if (principal.user.role === 'ADMIN') {
        return 'ALL';
      }
    }

    const folders = await this.loadFolders(cache);

    // PUBLIC fast-path: if NO folder is restricted, every folder is visible to any authenticated caller
    // (and to a fail-closed SA holding article:read) — one scan, no live-join queries.
    const restricted = folders.filter((f) => !f.isPublic);
    if (restricted.length === 0) {
      return new Set(folders.map((f) => f.id));
    }

    // §8 service accounts fail closed: an SA can never satisfy a (User-shaped) restriction, so it sees
    // ONLY public folders — never evaluate the rules for it.
    if (isServicePrincipal(principal)) {
      return new Set(folders.filter((f) => f.isPublic).map((f) => f.id));
    }

    const userId = principal?.user.id;
    const role = principal?.user.role;

    // Resolve the caller's live-join context ONCE (only the kinds actually used by a restricted folder).
    const usesAppGrant = restricted.some((f) =>
      f.rules.some((r) => r.kind === 'appGrant'),
    );
    const usesAssetAssignment = restricted.some((f) =>
      f.rules.some((r) => r.kind === 'assetAssignment'),
    );
    const grantedApplicationIds =
      usesAppGrant && userId
        ? await this.activeApplicationIds(userId)
        : new Set<string>();
    const assignedAssetIds =
      usesAssetAssignment && userId
        ? await this.activeAssetIds(userId)
        : new Set<string>();

    // Which folders the caller matches by their OWN rule (PUBLIC trivially matches; a restricted one is
    // matched iff ANY OR rule fires). Anonymous (no userId) matches no restriction; a malformed
    // restriction (isPublic=false, rules=[]) matches nobody → hidden.
    const ownMatch = new Map<string, boolean>();
    for (const folder of folders) {
      ownMatch.set(
        folder.id,
        folder.isPublic ||
          this.matchesOwnRule(folder.rules, {
            userId,
            role,
            grantedApplicationIds,
            assignedAssetIds,
          }),
      );
    }

    // §1 inherit-and-narrow: a folder is visible iff EVERY folder on its ancestor path (self + up) is
    // own-matched. A restricted ancestor the caller fails hides the whole subtree.
    const byId = new Map(folders.map((f) => [f.id, f]));
    const visible = new Set<string>();
    for (const folder of folders) {
      if (this.pathAllMatched(folder, byId, ownMatch)) {
        visible.add(folder.id);
      }
    }
    return visible;
  }

  /**
   * Does the caller match this restricted folder's OWN rule set (OR semantics — any rule lets them in)?
   * Pure in-memory over the pre-resolved live-join context. Never called for a PUBLIC folder.
   */
  private matchesOwnRule(
    rules: FolderAccessRule[],
    ctx: {
      userId?: string;
      role?: string;
      grantedApplicationIds: ReadonlySet<string>;
      assignedAssetIds: ReadonlySet<string>;
    },
  ): boolean {
    return rules.some((rule) => this.matchesRule(rule, ctx));
  }

  private matchesRule(
    rule: FolderAccessRule,
    ctx: {
      userId?: string;
      role?: string;
      grantedApplicationIds: ReadonlySet<string>;
      assignedAssetIds: ReadonlySet<string>;
    },
  ): boolean {
    switch (rule.kind) {
      case 'users':
        return ctx.userId !== undefined && rule.userIds.includes(ctx.userId);
      case 'role':
        return ctx.role !== undefined && ctx.role === rule.role;
      case 'appGrant':
        return ctx.grantedApplicationIds.has(rule.applicationId);
      case 'assetAssignment':
        return ctx.assignedAssetIds.has(rule.assetId);
    }
  }

  /**
   * Walk UP the ancestor chain from `folder`: the folder is visible iff every node (self + ancestors)
   * is own-matched. A `visited` guard makes the walk terminate even on a (data-level) cycle. A missing
   * ancestor (parent soft-deleted out from under it — SetNull never fires on soft delete, but a hard
   * delete safety net could) is treated as a broken chain → NOT visible (fail closed).
   */
  private pathAllMatched(
    folder: FolderNode,
    byId: Map<string, FolderNode>,
    ownMatch: Map<string, boolean>,
  ): boolean {
    const visited = new Set<string>();
    let cursor: FolderNode | undefined = folder;
    while (cursor !== undefined) {
      if (visited.has(cursor.id)) break; // pre-existing data cycle — stop
      visited.add(cursor.id);
      if (ownMatch.get(cursor.id) !== true) {
        return false; // a restricted node on the path the caller fails hides the subtree
      }
      if (cursor.parentId === null) {
        return true; // reached a root with every node matched
      }
      const parent = byId.get(cursor.parentId);
      if (parent === undefined) {
        // parentId points outside the live set (deleted ancestor) — fail closed rather than widen.
        return false;
      }
      cursor = parent;
    }
    return true;
  }

  /**
   * All LIVE folders with the columns the walk needs. `accessRules` jsonb → parsed `isPublic`/`rules`.
   *
   * When a request-scoped {@link FolderTreeCache} is passed (#599), the full `findMany` runs at most
   * ONCE per request: the first call populates `cache.folders`, later calls reuse it. The tree is the
   * only thing memoized — the live-join lookups in {@link visibleFolderIds} still run per call, so
   * access stays dynamic-by-construction (a revoked grant / released asset drops on the next read).
   */
  private async loadFolders(cache?: FolderTreeCache): Promise<FolderNode[]> {
    if (cache?.folders !== undefined) {
      return cache.folders;
    }
    const rows = await this.prisma.articleCategory.findMany({
      select: { id: true, parentId: true, accessRules: true },
    });
    const folders = rows.map((r) => {
      const { isPublic, rules } = this.resolveRules(r.accessRules);
      return { id: r.id, parentId: r.parentId, isPublic, rules };
    });
    if (cache !== undefined) {
      cache.folders = folders;
    }
    return folders;
  }

  /**
   * Resolve a folder's stored jsonb `accessRules` into the `{ isPublic, rules }` the walk uses (§2/§3).
   *
   *  - `null` / `[]`  → PUBLIC (`isPublic: true`, no rule narrows from public).
   *  - a VALID rule list → `isPublic: false`, the parsed OR rules.
   *  - a MALFORMED value (corruption / hand-edited row) → `isPublic: false`, `rules: []` — it matches
   *    nobody, so a non-admin is HIDDEN. We deliberately fail CLOSED rather than treat an unparseable
   *    restriction as PUBLIC (which would leak the folder). Uses the LENIENT structural schema
   *    ({@link StoredRulesSchema}) — id FORMAT was already enforced at write time.
   */
  private resolveRules(raw: unknown): {
    isPublic: boolean;
    rules: FolderAccessRule[];
  } {
    if (raw == null) return { isPublic: true, rules: [] };
    if (Array.isArray(raw) && raw.length === 0) {
      return { isPublic: true, rules: [] };
    }
    const parsed = StoredRulesSchema.safeParse(raw);
    if (parsed.success) {
      return { isPublic: false, rules: parsed.data };
    }
    // Malformed restriction → not PUBLIC, but no valid rule to match → hidden from non-admins.
    return { isPublic: false, rules: [] };
  }

  /** The applicationIds the user holds an ACTIVE (un-revoked) grant on (§3c — `revokedAt IS NULL`). */
  private async activeApplicationIds(
    userId: string,
  ): Promise<ReadonlySet<string>> {
    const grants = await this.prisma.accessGrant.findMany({
      where: { userId, revokedAt: null },
      select: { applicationId: true },
    });
    return new Set(grants.map((g) => g.applicationId));
  }

  /** The assetIds the user is a CURRENT assignee of (§3d — `releasedAt IS NULL`). */
  private async activeAssetIds(userId: string): Promise<ReadonlySet<string>> {
    const assignments = await this.prisma.assetAssignment.findMany({
      where: { userId, releasedAt: null },
      select: { assetId: true },
    });
    return new Set(assignments.map((a) => a.assetId));
  }
}
