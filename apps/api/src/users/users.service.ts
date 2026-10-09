import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type {
  AdminPasswordResetDelivery,
  AdminPasswordResetOutcome,
  AdminPasswordResetResult,
  CloneUser,
  CloneUserResult,
  CreateUser,
  ManagerDescriptor,
  ManagerInput,
  PageQuery,
  PasswordResetCapabilities,
  ThemePreference,
  UiLocale,
  UpdateOwnProfile,
  UpdateUser,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma, Role } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { pickPublicUserColumns } from './public-user';
import type { PublicUserColumns } from './public-user';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { multiTokenWhere } from '../common/multi-token-where';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import type { ActorAttribution } from '../common/actor.service';
import { UserHistoryService } from '../user-history/user-history.service';
import { toThemePreference, toUiLocale } from './user-preferences.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { resolveIntegrationMode } from '../config/integration-mode';
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';
import {
  AdminResetLinkError,
  PasswordLifecycleService,
} from '../auth/local/password-lifecycle.service';

/**
 * The reserved, non-routable email DOMAIN the bulk import synthesizes for a directory person identified
 * ONLY by legajo/username (no real email) — ADR-0069 REDESIGN §4.5. The DB `email` column is non-null,
 * so the import mints `<sessionId>-<rowIndex>@directory.local` to keep the row valid + live-unique. Such
 * an address is NOT a real mailbox, so a person carrying it can never auto-promote by verified-email login.
 */
export const DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN = '@directory.local';

/**
 * Thrown by {@link UsersService.requestPasswordReset} outside local mode: the operator's IdP owns the
 * reset. The controller maps it to a 501, never a 2xx that pretends a reset was sent (INV-4).
 */
export class PasswordResetUnsupportedError extends Error {
  constructor(
    message = 'Password reset is managed by your identity provider; lazyit cannot trigger it.',
  ) {
    super(message);
    this.name = 'PasswordResetUnsupportedError';
  }
}

/** The manager-bearing columns a user row carries (ADR-0058) — the subset the read descriptor needs. */
type ManagerColumns = { managerId: string | null; managerName: string | null };

/**
 * The PUBLIC user shape the service returns (ADR-0058, SEC-085): ONLY the allowlisted
 * {@link PublicUserColumns} (never a credential, epoch or raw manager column) plus the resolved
 * `manager` descriptor. Timestamps stay Prisma `Date`s here —
 * the API serializes them to the ISO-string wire shape (UserSchema) at the HTTP boundary, exactly like
 * every other endpoint. The controller's `UserDto` / `CloneUserResultDto` document that wire shape.
 */
export type SerializedUser = Omit<PublicUserColumns, 'locale' | 'theme'> & {
  manager: ManagerDescriptor | null;
  locale: UiLocale | null;
  theme: ThemePreference | null;
};

/**
 * The `GET /users` LIST item the service emits (issue #386): a {@link SerializedUser} (timestamps stay
 * Prisma `Date`s — the HTTP boundary serializes them to ISO strings, matching the wire `UserListItem`
 * in `@lazyit/shared`) plus the two derived activity counts. The counts are batched per page (one
 * `groupBy` each, never N+1) and ride ONLY on the list row, so they're optional on the wire and absent
 * from the single-user reads.
 */
export type SerializedUserListItem = SerializedUser & {
  /** Active AssetAssignments held by the user (`releasedAt: null`, ADR-0019). */
  assetsInPossession: number;
  /** Active AccessGrants held by the user (`revokedAt: null`, ADR-0023). */
  appAccesses: number;
};

/**
 * The DB write fragment for the manager either/or (ADR-0058). `managerId` XOR `managerName` (or both
 * null). `undefined` here means "leave both columns untouched" (an update that didn't mention manager).
 */
type ManagerWrite =
  { managerId: string | null; managerName: string | null } | undefined;

/** Optional filters for listing users. */
export interface UserFilters {
  /** Case-insensitive substring over firstName / lastName / email (OR). */
  q?: string;
  /**
   * Directory-person filter (ADR-0069 REDESIGN §0 #2).
   * true  → only directory-only persons (no login).
   * false → only login-backed accounts.
   * absent/undefined → all users (default; no filter).
   */
  directoryOnly?: boolean;
  /**
   * RBAC role filter (issue #693). When set, scope the list to users holding exactly this role —
   * the deep-link target of the Settings → Roles "View N members" link (`/users?role=VIEWER`).
   * absent/undefined → all roles (default; no filter). Validated by `RoleSchema` at the controller.
   */
  role?: Role;
  /**
   * Batch id→name resolver filter (issue #961). When set, scope the list to exactly these user ids
   * (`id IN (…)`) — the read-only name-resolution path that replaced the truncated whole-directory
   * `useUsers()` hook (history timelines, grantee chips, vault member chips, KB committed-rule names).
   * De-duplicated + capped (`ResolveUserIdsSchema`, ≤ MAX_RESOLVE_USER_IDS) and each element validated
   * as a UUID at the controller, so the IN clause is always bounded and well-formed. An unknown id
   * simply matches no row (silently ignored, never a 400). absent/undefined → no filter (default).
   */
  ids?: string[];
  /**
   * Activation filter (issue #1375). true → only active accounts; false → only deactivated ones.
   * absent/undefined → both (default; no filter). Validated as exactly "true" | "false" at the controller.
   */
  isActive?: boolean;
}

/**
 * Server-side sort allowlist for `GET /users` (ADR-0030 amendment). Maps each PUBLIC `?sort=` key to
 * the Prisma column. Unknown key → 400. With no `sort`, the list keeps its default `createdAt desc`.
 */
export const USER_SORT_ALLOWLIST = {
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  role: 'role',
  createdAt: 'createdAt',
} as const;

/** What an offboarding reclaimed/revoked, for the response + the audit story. */
export interface OffboardResult {
  /** The soft-deleted user (deletedAt stamped). */
  userId: string;
  /** Asset assignments released (reclaimed assets), by id. */
  releasedAssignments: { id: string; assetId: string }[];
  /** Count of active access grants revoked. */
  revokedGrants: number;
  /**
   * Count of Secret-vault crypto memberships hard-dropped (issue #869). INV-10-safe: a membership is a
   * wrapped-DEK row, so revoking it is a pure row-delete — the server never decrypts anything.
   */
  revokedVaultMemberships: number;
  /**
   * The vaults the departing user could read, as a ROTATION PROMPT (issue #869). Pure metadata only —
   * vault name + live item count, left of the ADR-0061 §9 zero-knowledge line: NEVER a value, key or
   * ciphertext. Purely informational: lazyit cannot auto-rotate (the server can't re-encrypt), so an
   * operator must rotate these secrets manually. Empty when the user was a member of no vault.
   */
  rotationVaults: { vaultId: string; name: string; itemCount: number }[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly assignments: AssetAssignmentsService,
    // Append-only User lifecycle log (DEBT-2, issue #185). Each write-path emits a UserHistory row
    // transactionally with the change it records (ADR-0033 pattern), so the audit trail can never
    // diverge from the data. Feeds the recent_activity view's user branch.
    private readonly history: UserHistoryService,
    // Asset-history emitter (ADR-0033). The clone writes an ASSIGNED asset-history row per cloned
    // assignment, transactionally with the assignment row (same client), mirroring AssetAssignmentsService.
    private readonly assetHistory: AssetHistoryService,
    // Workflow engine outbox (ADR-0054 / ADR-0058 §4 clone). The clone's engine toggle reuses the
    // SAME transactional-outbox path as a hand-created grant: plan BEFORE the tx, write a PENDING run
    // row INSIDE the tx, enqueue AFTER commit — but only when fireWorkflowsOnClonedGrants is true.
    private readonly workflowTrigger: WorkflowTriggerService,
    // Notification-bell emitter (ADR-0056 §3 / ADR-0058 §4 clone, issue #359). The clone writes its
    // cloned grants directly (to govern the engine toggle), so it reuses AccessGrantsService's bell
    // emitter post-commit to fire the SAME admin_granted / critical_app_access nudges a hand-created
    // grant produces. The bell is admin VISIBILITY — independent of the engine fire toggle.
    private readonly accessGrants: AccessGrantsService,
    // Local (first-party) provisioning primitive (ADR-0086 §5). Used only in the local-mode
    // branches of create() + requestPasswordReset() to hash/store passwords and mint temp-passwords —
    // no IdP mirror. Global (AuthModule), so no module import is needed here.
    private readonly provisioning: LocalProvisioningService,
    // Local password-lifecycle machinery (ADR-0086 §F4). Issue #1268 reuses its PasswordResetToken +
    // reset-mail path for the admin `email` delivery rather than growing a second copy of it. Injected
    // via LocalAuthModule (imported by UsersModule); it self-gates on local mode.
    private readonly passwordLifecycle: PasswordLifecycleService,
    @InjectPinoLogger(UsersService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** True when the instance runs first-party local auth (AUTH_MODE=local, ADR-0086 §5). */
  private isLocalMode(): boolean {
    return resolveIntegrationMode(process.env.AUTH_MODE) === 'local';
  }

  /**
   * A single page of users (default `createdAt desc`). Server-side `q` search (over
   * firstName/lastName/email) and an allowlisted sort make the list authoritative — migrated off the
   * raw-array contract that filtered client-side and silently truncated past the window (ADR-0030).
   * The `deleted` slice (`active` default | `only`) scopes the page to live or soft-deleted
   * (offboarded) users; `only` carries the ADR-0032 `includeSoftDeleted` escape hatch so the read
   * filter doesn't re-hide them (ADMIN-gated at the controller). Runs `findMany(take/skip)` + `count`
   * over the same `where` in one `$transaction`.
   */
  async findPage(filters: UserFilters, page: PageQuery) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.UserOrderByWithRelationInput>(
        page,
        USER_SORT_ALLOWLIST,
      ) ??
      ({ createdAt: 'desc' } satisfies Prisma.UserOrderByWithRelationInput);
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object rather than fighting the type.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, orderBy, take, skip, ...escapeHatch }),
      this.prisma.user.count({ where, ...escapeHatch }),
    ]);
    // Resolve the manager descriptor for every row on the page in ONE batched query (ADR-0058), so the
    // list item matches the full UserSchema (which now carries `manager`) without an N+1 per row.
    const serialized = await this.serializeUsers(items);
    // Attach the two derived activity counts (issue #386) — batched per page, NEVER N+1: one `groupBy`
    // each over the page's user ids (two queries total, regardless of page size). LIST-only fields.
    const withCounts = await this.attachActivityCounts(serialized);
    return pageOf(withCounts, total, page);
  }

  /**
   * Attach the two derived, list-only activity counts to each row of a page (issue #386), batched so the
   * cost is O(1 query per count per page) — NEVER N+1:
   *
   *   - `assetsInPossession` — the user's currently-held assets: active {@link
   *     ../asset-assignments/asset-assignments.service AssetAssignment}s (`releasedAt: null`, ADR-0019).
   *   - `appAccesses` — the user's currently-held application grants: active {@link
   *     ../access-grants/access-grants.service AccessGrant}s (`revokedAt: null`, ADR-0023).
   *
   * Each count is one Prisma `groupBy` by `userId` over the WHOLE page's ids (`userId IN (<page>)`),
   * filtered to the ACTIVE lifecycle (released/revoked rows are excluded). Both joins are append-only
   * (no `deletedAt`), so there is no soft-delete filter to apply here. A user with no rows is absent
   * from its groupBy result and defaults to `0`. An empty page skips both queries entirely.
   */
  private async attachActivityCounts(
    rows: SerializedUser[],
  ): Promise<SerializedUserListItem[]> {
    if (rows.length === 0) {
      // Empty page: nothing to aggregate — skip BOTH groupBy queries (zero wasted DB round-trips).
      return [];
    }
    const userIds = rows.map((r) => r.id);
    // Two queries TOTAL for the page — one per count. groupBy returns one row per user that HAS at least
    // one active row; users with none are simply absent (→ default 0 below). _count._all = the row count.
    const [assetGroups, grantGroups] = await Promise.all([
      this.prisma.assetAssignment.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, releasedAt: null },
        _count: { _all: true },
      }),
      this.prisma.accessGrant.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, revokedAt: null },
        _count: { _all: true },
      }),
    ]);
    const assetsByUser = new Map(
      assetGroups.map((g) => [g.userId, g._count._all]),
    );
    const grantsByUser = new Map(
      grantGroups.map((g) => [g.userId, g._count._all]),
    );
    return rows.map((row) => ({
      ...row,
      assetsInPossession: assetsByUser.get(row.id) ?? 0,
      appAccesses: grantsByUser.get(row.id) ?? 0,
    }));
  }

  /** The shared `where` for the user list — used identically by findPage and its count. */
  private buildWhere({
    q,
    directoryOnly,
    role,
    ids,
    isActive,
  }: UserFilters): Prisma.UserWhereInput {
    return {
      // Token-wise match (issue #1053): each whitespace-separated token of `q` must appear in
      // firstName, lastName OR email — so "Nahuel Genari" matches firstName+lastName across columns.
      ...multiTokenWhere(q, ['firstName', 'lastName', 'email']),
      // directoryOnly filter (ADR-0069 REDESIGN §0 #2): absent → no filter (show all).
      ...(directoryOnly !== undefined ? { directoryOnly } : {}),
      // role filter (issue #693): absent → no filter; backs the Roles "View N members" deep-link.
      ...(role ? { role } : {}),
      // ids filter (issue #961): the batch id→name resolver — scope to exactly these ids. Absent or
      // empty → no filter. Unknown ids simply match nothing (the IN clause ignores them silently).
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      // isActive filter (issue #1375): absent → no filter (active and deactivated alike).
      ...(isActive !== undefined ? { isActive } : {}),
    };
  }

  /**
   * Per-role LIVE user counts (issue #693): `{ ADMIN, MEMBER, VIEWER }` over the active (not
   * soft-deleted) directory. ONE Prisma `groupBy` on `role` (not three list calls) — the lazy,
   * cheap, exact source for the Settings → Roles cards, correct at any team size. A role with no
   * holders is absent from the groupBy result and defaults to `0`, so every key is always present.
   */
  async roleCounts(): Promise<Record<Role, number>> {
    const groups = await this.prisma.user.groupBy({
      by: ['role'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byRole = new Map(groups.map((g) => [g.role, g._count._all]));
    // Seed every role to 0 so the response is exhaustive (a role with no holders is never omitted).
    const counts = Object.fromEntries(
      Object.values(Role).map((role) => [role, byRole.get(role) ?? 0]),
    ) as Record<Role, number>;
    return counts;
  }

  // --- manager read-descriptor resolution (ADR-0058) ----------------------

  /**
   * Resolve ONE user row into the PUBLIC wire shape: attach the `manager` descriptor (ADR-0058). The
   * raw `managerId` / `managerName` columns are dropped from the wire — only the resolved, redaction-
   * safe descriptor (display name; `isOffboarded` for a soft-deleted linked manager) is exposed.
   */
  async serializeUser(row: User): Promise<SerializedUser> {
    const [serialized] = await this.serializeUsers([row]);
    return serialized;
  }

  /**
   * Resolve a batch of user rows into the public wire shape in ONE query for all linked managers
   * (avoids an N+1 on the list). Linked managers are looked up via the `includeSoftDeleted` escape
   * hatch (ADR-0032) so a soft-deleted (offboarded) manager is still FOUND — and flagged
   * `isOffboarded: true` — rather than dangling (Q2). A `managerId` that points at a genuinely-gone row
   * resolves to `null` (never a dangle). `managerName` becomes the `external` descriptor.
   */
  async serializeUsers(rows: User[]): Promise<SerializedUser[]> {
    const managerIds = [
      ...new Set(
        rows.map((r) => r.managerId).filter((id): id is string => id != null),
      ),
    ];
    const managers =
      managerIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: managerIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              deletedAt: true,
            },
            // See the soft-deleted manager note above — surface it as isOffboarded, don't drop it.
            includeSoftDeleted: true,
          } as Prisma.UserFindManyArgs)
        : [];
    const byId = new Map(managers.map((m) => [m.id, m]));
    return rows.map((row) => ({
      // ALLOWLIST, never a spread of the row (SEC-085): only the PUBLIC_USER_SELECT columns reach the
      // wire, so passwordHash, the session/MCP epochs and every future column stay server-side.
      ...pickPublicUserColumns(row),
      manager: this.toManagerDescriptor(row, byId),
      // Per-user UI preferences (issue #1422), read-tolerant: an unknown stored value reads as null.
      locale: toUiLocale(row.locale),
      theme: toThemePreference(row.theme),
    }));
  }

  /**
   * Build the redaction-safe `manager` descriptor from a row's manager columns (ADR-0058):
   *   - a LIVE / soft-deleted linked user → `{ type: "user", id, firstName, lastName, isOffboarded }`
   *     (`isOffboarded` = the linked manager's `deletedAt != null`);
   *   - the free-text fallback → `{ type: "external", name }`;
   *   - nothing recorded, or a `managerId` whose row is genuinely gone → `null` (never a dangle).
   */
  private toManagerDescriptor(
    row: ManagerColumns,
    byId: Map<
      string,
      {
        id: string;
        firstName: string;
        lastName: string;
        deletedAt: Date | null;
      }
    >,
  ): ManagerDescriptor | null {
    if (row.managerId != null) {
      const m = byId.get(row.managerId);
      if (!m) {
        return null;
      }
      return {
        type: 'user',
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        isOffboarded: m.deletedAt != null,
      };
    }
    if (row.managerName != null) {
      return { type: 'external', name: row.managerName };
    }
    return null;
  }

  // --- manager write resolution + self/cycle guard (ADR-0058) -------------

  /**
   * Translate the `manager` input union into the DB write fragment (ADR-0058), validating the FK,
   * rejecting a self-manager and a CYCLE. Returns `undefined` when `manager` was omitted (leave both
   * columns untouched); `{ managerId, managerName }` (exactly one non-null, or both null to clear)
   * otherwise. `subjectId` is the user being written (null on create — no cycle possible yet).
   */
  private async resolveManagerWrite(
    manager: ManagerInput | null | undefined,
    subjectId: string | null,
  ): Promise<ManagerWrite> {
    if (manager === undefined) {
      return undefined; // not mentioned → leave unchanged
    }
    if (manager === null) {
      return { managerId: null, managerName: null }; // clear
    }
    if (manager.managerId !== undefined) {
      await this.assertManagerLinkValid(manager.managerId, subjectId);
      return { managerId: manager.managerId, managerName: null };
    }
    if (manager.managerName !== undefined) {
      return { managerId: null, managerName: manager.managerName };
    }
    // `{}` (both omitted) — treat as "clear" so the wire union's empty object is honoured.
    return { managerId: null, managerName: null };
  }

  /**
   * Validate a `managerId` link (ADR-0058): the target must be a LIVE user (400 otherwise), must not be
   * the subject themselves (400 — the DB CHECK backstops it), and must not introduce a CYCLE (400). The
   * cycle check walks UP the chain from the proposed manager: if we ever reach the subject, linking
   * would close a loop. Chains are short in a 5–20-person org, so the DFS is negligible; a `visited`
   * set also guards against any pre-existing loop in the data so the walk always terminates.
   */
  private async assertManagerLinkValid(
    managerId: string,
    subjectId: string | null,
  ): Promise<void> {
    if (subjectId != null && managerId === subjectId) {
      throw new BadRequestException('A user cannot be their own manager');
    }
    const manager = await this.prisma.user.findFirst({
      where: { id: managerId },
      select: { id: true, managerId: true },
    });
    if (!manager) {
      throw new BadRequestException(
        `managerId ${managerId} does not reference a live user`,
      );
    }
    if (subjectId == null) {
      return; // creating a new user — it has no reports yet, so no cycle is possible
    }
    // Walk up from the proposed manager; reaching the subject means this link would close a cycle.
    const visited = new Set<string>([managerId]);
    let cursor: string | null = manager.managerId;
    while (cursor != null) {
      if (cursor === subjectId) {
        throw new BadRequestException(
          'Assigning this manager would create a management cycle',
        );
      }
      if (visited.has(cursor)) {
        break; // pre-existing loop in the data — stop (the new link doesn't involve the subject)
      }
      visited.add(cursor);
      const next: { managerId: string | null } | null =
        await this.prisma.user.findFirst({
          where: { id: cursor },
          select: { managerId: true },
        });
      cursor = next?.managerId ?? null;
    }
  }

  /**
   * A single non-deleted user by id; throws 404 if missing or deleted. Returns the RAW Prisma row (the
   * manager columns are unresolved) — used internally as a 404 guard and by paths that re-serialize.
   * The PUBLIC read shape is produced by {@link findOneSerialized} / {@link serializeUser}.
   */
  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  /**
   * A single non-deleted user by id, in the PUBLIC wire shape (ADR-0058): the manager FK is resolved to
   * a redaction-safe descriptor (display name only; a soft-deleted linked manager surfaces
   * `isOffboarded`). 404 if missing or soft-deleted. This is what `GET /users/:id` returns.
   */
  async findOneSerialized(id: string) {
    const user = await this.findOne(id);
    return this.serializeUser(user);
  }

  /**
   * Create a user. Returns the PUBLIC wire shape (manager descriptor resolved, ADR-0058).
   *
   * `opts.createdPayload` lets the clone path (ADR-0058 §4) record `{ clonedFrom, fireWorkflows }` in
   * the CREATED UserHistory payload so the provisioning choice is never silent; a plain create passes
   * nothing (no payload). The manager either/or is validated here (FK live + the XOR; a NEW user has no
   * reports yet, so no cycle is possible — `subjectId = null`).
   *
   * Optional temporary password (ADR-0064, issue #411): honoured only in local mode, where it is hashed
   * with `mustChangePassword`. Under OIDC the operator's IdP owns the credential, so a supplied password
   * is a 400 before any row is created (ADR-0102 §5).
   */
  async create(
    data: CreateUser,
    actorId?: string,
    opts?: {
      createdPayload?: Prisma.InputJsonValue;
      // ADR-0069 REDESIGN §4.5: the bulk-import DIRECTORY branch. When true, this create is a
      // directory-only person (no login) and `directoryOnly`/`directoryAttrs` are stamped on the
      // row. NEVER client-supplied: the public Users controller never passes it; only the import
      // commit engine (a trusted server caller) does. The role is FORCED to VIEWER here regardless of
      // payload (role-escalation closed) — CreateDirectoryPersonSchema doesn't even carry `role`.
      skipIdpWriteBack?: boolean;
      directoryAttrs?: Prisma.InputJsonValue;
      // ADR-0091 (#839): AD/LDAP directory-source provenance stamped on the NEW directory person. Only the
      // read-only directory reconcile (a trusted server caller) passes these; the public Users controller
      // never does. `directorySource` discriminates the origin ("ad"); `directorySourceId` is the AD
      // objectGUID canonical string — the immutable natural key the reconcile upserts on (NEVER externalId,
      // INV-2). Both are additive to the existing skipIdpWriteBack branch and change none of its invariants
      // (role stays VIEWER, externalId stays null, no login).
      directorySource?: string;
      directorySourceId?: string;
    },
  ): Promise<SerializedUser> {
    // RBAC default (ADR-0040, flipped to VIEWER by ADR-0043): an omitted role lands the least-
    // privileged read-only role. We set it explicitly here (rather than leaning on the Prisma column
    // default) so the service is the authoritative default for app-created users and the behaviour is
    // testable without a DB. The Users controller is ADMIN-gated, so an ADMIN may still pass any role.
    // A directory-only person is ALWAYS VIEWER — never trust the payload (which can't carry role anyway).
    const role = opts?.skipIdpWriteBack
      ? Role.VIEWER
      : (data.role ?? Role.VIEWER);
    // Resolve the manager either/or → DB columns (ADR-0058). On create there is no subject yet, so no
    // cycle is possible; the FK-live + at-most-one checks still apply. Then build the explicit create
    // data (manager/legajo/username are columns; `manager` the input union is NOT — strip + translate).
    const managerWrite = await this.resolveManagerWrite(data.manager, null);
    const createData = this.buildProfileCreateData(data, role, managerWrite);

    // ADR-0069 REDESIGN §4.5: the DIRECTORY branch. A directory-only person has NO login. We stamp
    // `directoryOnly`/`directoryAttrs`, persist the row, record its CREATED history (correlated to the
    // import session via `createdPayload`), sync search, and return. `externalId` stays null (SEC-006);
    // `role` is VIEWER (forced above).
    if (opts?.skipIdpWriteBack) {
      const directoryUser = await this.prisma.user.create({
        data: {
          ...createData,
          directoryOnly: true,
          ...(opts.directorySource !== undefined
            ? { directorySource: opts.directorySource }
            : {}),
          ...(opts.directorySourceId !== undefined
            ? { directorySourceId: opts.directorySourceId }
            : {}),
          ...(opts.directoryAttrs !== undefined
            ? { directoryAttrs: opts.directoryAttrs }
            : {}),
        },
      });
      await this.recordHistory(
        this.prisma,
        directoryUser.id,
        'CREATED',
        actorId,
        opts.createdPayload,
      );
      this.search.upsert('users', projectUser(directoryUser));
      return this.serializeUser(directoryUser);
    }
    // LOCAL mode (ADR-0086 §5): lazyit OWNS the credential. When a password is supplied it is an
    // admin-provisioned TEMP credential (ADR-0064 semantics), so we hash it to `passwordHash` and set
    // `mustChangePassword` (stored now; enforcement is F4). Without a password the row lands password-less
    // (imported / provision-later): it cannot log in until an admin sets one. No IdP call; externalId null.
    if (this.isLocalMode()) {
      const localData = data.password
        ? {
            ...createData,
            ...(await this.provisioning.credentialFields(data.password, {
              mustChangePassword: true,
            })),
          }
        : createData;
      const localUser = await this.prisma.user.create({ data: localData });
      await this.recordHistory(
        this.prisma,
        localUser.id,
        'CREATED',
        actorId,
        opts?.createdPayload,
      );
      this.search.upsert('users', projectUser(localUser));
      return this.serializeUser(localUser);
    }
    // OIDC: the operator's IdP owns the credential, so a supplied password has nowhere valid to go.
    if (data.password) {
      throw new BadRequestException(
        'Temporary passwords are only available in local authentication mode; your identity provider owns the credential.',
      );
    }
    // The person signs in through the IdP; JIT links `externalId` on first sign-in (ADR-0038).
    const user = await this.prisma.user.create({ data: createData });
    await this.recordHistory(
      this.prisma,
      user.id,
      'CREATED',
      actorId,
      opts?.createdPayload,
    );
    // Fire-and-forget search sync (ADR-0035): un-awaited, never throws, no-op when Meili is disabled.
    this.search.upsert('users', projectUser(user));
    return this.serializeUser(user);
  }

  /**
   * ONBOARD a directory-only person in LOCAL auth mode (AUTH_MODE=local, ADR-0086 §5 amendment, issue
   * #1072). After a Snipe-IT / LAN mass import every person lands `directoryOnly=true`, password-less,
   * and in local mode the self-service onboarding paths are closed by construction (login rejects
   * directoryOnly; requestPasswordReset 422s a directory person). So an admin explicitly
   * mints a ONE-TIME temporary password here, using the EXACT primitives the local admin-reset uses:
   * `generateTempPassword()` + `credentialFields({ mustChangePassword: true })` (ADR-0064 semantics).
   *
   * In ONE transaction we set the credential AND flip `directoryOnly=false` (the row becomes a login
   * account — login now accepts it), then append the audited history row. The temp password is RETURNED
   * ONCE (never persisted in plaintext, never shown again — same `AdminPasswordResetResult` shape the
   * admin-reset returns). SECURITY: no self-service (admin-action-gated), no role widening (the import
   * forced VIEWER and onboarding keeps the existing role — never trusts a payload, carries none), and
   * `mustChangePassword` narrows the hand-off window (forced change at first login).
   *
   * Guards: 404 if missing/soft-deleted (findOne); 400 under OIDC (no local credential to mint — the
   * person signs in through the IdP and claims the row by verified email, ADR-0038); 400 if the target
   * is NOT a directory person (a real account already owns/manages a credential — use
   * requestPasswordReset instead). No `sessionEpoch` bump: a directory
   * person holds no session to revoke (unlike the admin-reset, which kills a live user's sessions).
   */
  async provisionLocalAccount(
    id: string,
    actorId?: string,
  ): Promise<AdminPasswordResetResult> {
    const target = await this.findOne(id); // 404 if missing or soft-deleted
    // Local mode ONLY: there is no IdP here, so lazyit owns the credential. Under OIDC the IdP owns
    // onboarding instead.
    if (!this.isLocalMode()) {
      throw new BadRequestException(
        'Local onboarding is only available in local authentication mode.',
      );
    }
    // Only a directory-only person is onboarded here. A real account already has (or manages) a
    // credential — reset it with requestPasswordReset instead of minting a second one.
    if (!target.directoryOnly) {
      throw new BadRequestException(
        'This user already has an account; only a directory person can be onboarded.',
      );
    }

    // Mint the SAME one-time temp credential the local admin-reset uses (ADR-0064): a strong random
    // password hashed to `passwordHash` with `mustChangePassword=true` (forced change at first login).
    const temporaryPassword = this.provisioning.generateTempPassword();
    const credential = await this.provisioning.credentialFields(
      temporaryPassword,
      { mustChangePassword: true },
    );
    // ONE tx: set the credential AND flip directoryOnly=false (the row transitions to a login account),
    // then append the audited history row atomically. The role is passed through UNCHANGED — onboarding
    // never widens privilege (the import forced VIEWER; we never touch `role` here). Reuse UPDATED (no
    // new enum/migration) with an action payload so the audit trail names the transition unambiguously.
    const onboarded = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { ...credential, directoryOnly: false },
      });
      await this.recordHistory(tx, id, 'UPDATED', actorId, {
        action: 'provisionLocalAccount',
        directoryOnly: false,
      });
      return updated;
    });
    this.auditWriteBack('provisionLocalAccount', actorId, id, { local: true });
    this.search.upsert('users', projectUser(onboarded));
    // The plaintext is returned to the admin to hand off ONCE — never stored in plaintext or shown again.
    return { temporaryPassword };
  }

  /**
   * Build the Prisma create data from a CreateUser payload (ADR-0058): the `manager` INPUT union is NOT
   * a column — strip it and substitute the resolved `managerWrite` (managerId XOR managerName). legajo /
   * username ARE columns (already normalized by the schema). Role is set explicitly (the caller resolves
   * the default). `externalId` is never here (SEC-006). NEVER pass the source's email/legajo/username on
   * a clone — the caller's `profile` supplies a distinct identity.
   */
  private buildProfileCreateData(
    data: CreateUser,
    role: Role,
    managerWrite: ManagerWrite,
  ): Prisma.UserUncheckedCreateInput {
    // Map only the real columns: `manager` (the input union) and the caller-resolved `role` are NOT
    // spread from `data` — manager becomes the resolved columns, role is the explicit param.
    return {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      role,
      ...(data.legajo !== undefined ? { legajo: data.legajo } : {}),
      ...(data.username !== undefined ? { username: data.username } : {}),
      ...(managerWrite ?? {}),
    };
  }

  /** Structured audit line for a successful IdP write-back (ADR-0043 §3 — no DB audit table yet). */
  private auditWriteBack(
    operation: string,
    actorId: string | undefined,
    subjectUserId: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger.info(
      { op: operation, actor: actorId ?? 'system', subjectUserId, fields },
      `IdP write-back: ${operation}`,
    );
  }

  /**
   * Append one UserHistory row (DEBT-2, issue #185) using the given client — pass the `$transaction`
   * client to keep the log atomic with the write it records (ADR-0033). The create/update/role-change/
   * password-reset routes attribute a HUMAN actor (`@CurrentUser` → `actorId`), so this overload takes
   * the human id and maps it to `{ userId }`; `undefined` → a system/unknown actor (both FKs null). The
   * offboard/restore paths attribute the full principal (human XOR service account) and call the
   * UserHistoryService directly with the resolved {@link ActorAttribution}.
   */
  private recordHistory(
    client: Parameters<UserHistoryService['record']>[0],
    userId: string,
    eventType: Parameters<UserHistoryService['record']>[1]['eventType'],
    actorId: string | undefined,
    payload?: Prisma.InputJsonValue,
  ): Promise<unknown> {
    return this.history.record(client, {
      userId,
      eventType,
      ...(payload !== undefined ? { payload } : {}),
      // A human actor → { userId }; system/unknown → {} (both FKs null). A service account never reaches
      // these human-only routes (@CurrentUser), so the human-id mapping is complete here.
      actor: actorId != null ? { userId: actorId } : {},
    });
  }

  async update(id: string, data: UpdateUser, actorId?: string) {
    const current = await this.findOne(id); // 404 if missing or already soft-deleted

    // RBAC safety guards (ADR-0040) — only run when a role change is actually requested.
    if (data.role !== undefined && data.role !== current.role) {
      // No self-escalation/demotion: an ADMIN cannot change their OWN role (403). Privilege changes
      // must be made BY one admin ON another, so a single admin can never quietly elevate or strip
      // their own role and there is always a second pair of hands in the loop.
      if (actorId !== undefined && actorId === id) {
        throw new ForbiddenException('You cannot change your own role');
      }
    }

    // Never strip the LAST usable ADMIN of its administrator powers — that would leave the instance with
    // no administrator and no way to recover from the UI (409). Both a demotion away from ADMIN and a
    // deactivation do that: an inactive account cannot authenticate (JwtAuthGuard), so disabling the
    // only active ADMIN — including yourself — bricks administration exactly like demoting it (SEC-021).
    // Demoting or deactivating any other admin is fine.
    const deactivating = data.isActive === false && current.isActive;
    const demotingAdmin =
      current.role === 'ADMIN' &&
      data.role !== undefined &&
      data.role !== 'ADMIN';
    if (demotingAdmin || (deactivating && current.role === 'ADMIN')) {
      await this.assertNotLastAdmin(id);
    }

    const roleChanged = data.role !== undefined && data.role !== current.role;
    // A field only counts as CHANGED when it is present AND differs from the stored value — so a PATCH
    // that resends the same name/email records nothing. `email` is already normalized (trim+lowercase,
    // citext) by the schema (ADR-0041).
    const nameChanged =
      (data.firstName !== undefined && data.firstName !== current.firstName) ||
      (data.lastName !== undefined && data.lastName !== current.lastName);
    const emailChanged =
      data.email !== undefined && data.email !== current.email;
    // Activation (issue #1375): a real flip of `isActive` is its own audited event — DEACTIVATED /
    // REACTIVATED — so it surfaces in Reports → Users with its actor. A PATCH that resends the stored
    // value is not a change and logs nothing. `deactivating` (above) is the true→false half.
    const reactivating = data.isActive === true && !current.isActive;
    // legajo / username (ADR-0058) are local directory identifiers; an edit is still a profile change the
    // log records (issue #1375 — they used to change silently).
    // `null` clears; a string is already normalized by the schema.
    const legajoChanged =
      data.legajo !== undefined && data.legajo !== (current.legajo ?? null);
    const usernameChanged =
      data.username !== undefined &&
      data.username !== (current.username ?? null);

    // Resolve the manager either/or → DB columns (ADR-0058): validates the FK is live, rejects a
    // self-manager and a CYCLE (DFS up the chain, with `id` as the subject). `undefined` when manager
    // wasn't in the PATCH (leave the columns untouched).
    const managerWrite = await this.resolveManagerWrite(data.manager, id);
    const managerChanged =
      managerWrite !== undefined &&
      (managerWrite.managerId !== current.managerId ||
        managerWrite.managerName !== current.managerName);

    // The `manager` INPUT union is NOT a column — separate it out (rest keeps only the real scalar
    // columns) and substitute the resolved columns. legajo / username ARE columns (normalized by the
    // schema); they pass through. `manager` is voided so the rest-destructure isn't flagged unused.
    const { manager, ...scalarData } = data;
    void manager;
    // Deactivating revokes every local session (ADR-0086 §3/§8): the guard already refuses an inactive
    // account, but without the epoch bump a later REACTIVATION would revive every token minted before it —
    // including a "keep me signed in" token that never expires by time. Harmless outside local mode.
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...scalarData,
        ...(managerWrite ?? {}),
        // …and every MCP connection / personal token (ADR-0097 decision 8, amended 2026-09-24).
        ...(deactivating
          ? {
              sessionEpoch: { increment: 1 },
              mcpCredentialEpoch: { increment: 1 },
              // A stale sync stamp would let the directory sync undo this deactivation (#1311).
              directoryOffboardedAt: null,
              directoryReenabledAt: null,
            }
          : {}),
        // The directory sync must not undo an admin's re-enable while the person stays absent (#1522).
        ...(reactivating ? { directoryReenabledAt: new Date() } : {}),
      },
    });

    // Emit UserHistory (DEBT-2, issue #185) for what changed. An activation flip, a role change, a
    // manager change and a profile edit can all happen in one PATCH, so emit each that fired (a
    // DEACTIVATED / REACTIVATED has no payload; a ROLE_CHANGED carries { from, to }; a MANAGER_CHANGED
    // carries { from, to } where each side is a user-id | external-name | null; an UPDATED carries which
    // fields changed — name / email / legajo / username). Atomic in one transaction with the durable final
    // state (ADR-0033). Every route into here — the web UI, the API and an AI tool call (which dispatches
    // to this same PATCH route) — lands on this one emitter, so the AI path is stamped with its
    // `aiInvocationId` by UserHistoryService (ADR-0097 decision 11).
    // Activation and the local identifiers (legajo / username) are recorded the same way (issue #1375).
    const identifierFields = [
      ...(legajoChanged ? (['legajo'] as const) : []),
      ...(usernameChanged ? (['username'] as const) : []),
    ];
    const updatedFields = [
      ...(nameChanged ? (['name'] as const) : []),
      ...(emailChanged ? (['email'] as const) : []),
      ...identifierFields,
    ];
    if (
      roleChanged ||
      managerChanged ||
      updatedFields.length > 0 ||
      deactivating ||
      reactivating
    ) {
      await this.prisma.$transaction(async (tx) => {
        if (deactivating || reactivating) {
          await this.recordHistory(
            tx,
            id,
            deactivating ? 'DEACTIVATED' : 'REACTIVATED',
            actorId,
          );
        }
        if (roleChanged) {
          await this.recordHistory(tx, id, 'ROLE_CHANGED', actorId, {
            from: current.role,
            to: data.role!,
          });
        }
        if (managerChanged) {
          // { from, to }: each side is the manager-user-id, the external-name string, or null (ADR-0058).
          await this.recordHistory(tx, id, 'MANAGER_CHANGED', actorId, {
            from: current.managerId ?? current.managerName ?? null,
            to: managerWrite.managerId ?? managerWrite.managerName ?? null,
          });
        }
        if (updatedFields.length > 0) {
          await this.recordHistory(tx, id, 'UPDATED', actorId, {
            // WHICH fields changed, never the old/new values.
            fields: updatedFields,
          });
        }
      });
    }

    this.search.upsert('users', projectUser(user));
    return this.serializeUser(user);
  }

  /**
   * SELF-SERVICE name edit — `PATCH /users/me` (issue #1421, CEO decision "only first and last name").
   * The caller is the subject AND the actor; the id comes from the authenticated principal, never the
   * body, so there is no cross-user write. `UpdateOwnProfileSchema` (strict) has already rejected every
   * key but `firstName` / `lastName`, so email, role, legajo, username, manager and activation stay on
   * the ADMIN-only `PATCH /users/:id`.
   *
   * Refused with 409 `PROFILE_MANAGED_BY_DIRECTORY` when the AD/LDAP sync owns the person
   * (`directorySource` set, ADR-0091): the next sync would overwrite the name, so accepting it would be
   * a change that silently reverts. A `directoryOnly` person has no login and cannot reach here, but is
   * refused the same way for completeness.
   *
   * Everything else delegates to {@link update} with ONLY the name keys, so a self-edit gets exactly the
   * admin edit's behaviour: the search re-index and the same `UPDATED { fields: ['name'] }` history row,
   * attributed to the caller. No role / activation key is ever passed, so the RBAC and last-admin guards
   * are untouched.
   */
  async updateOwnProfile(self: User, data: UpdateOwnProfile) {
    const current = await this.findOne(self.id);
    if (current.directorySource != null || current.directoryOnly) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PROFILE_MANAGED_BY_DIRECTORY',
        message:
          'Your name comes from the company directory, so it cannot be changed here. Ask an administrator to change it in the directory.',
      });
    }
    return this.update(
      self.id,
      {
        ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
        ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      },
      self.id,
    );
  }

  /**
   * Admin password reset for a user (issue #149, #1268). Guards: 404 if the user is missing or
   * soft-deleted (findOne filters those out), 422 if the user is INACTIVE (`isActive=false`) — a disabled
   * account is not invited to set a new password until it is reactivated.
   *
   * OIDC: the operator's IdP owns the credential and its reset, so this throws
   * {@link PasswordResetUnsupportedError}, which the controller maps to an honest 501 "managed by your
   * identity provider" — never a 2xx that pretends a reset was sent (INV-4, ADR-0102 §5).
   *
   * LOCAL mode (ADR-0086 §5, amended by issue #1268): there is no IdP to email a link, so the
   * ADMIN picks the delivery explicitly and lazyit performs it:
   *   - `temporary-password` (and the DEFAULT when no body is sent) — mint a one-time temp-password
   *     LOCALLY, hash it to `passwordHash`, set `mustChangePassword`, BUMP the subject's `sessionEpoch`
   *     and audit `PASSWORD_RESET_BY_ADMIN`. The plaintext is RETURNED to the admin (shown once).
   *   - `email` — mint a single-use reset link and send it through the instance SMTP (ADR-0079), audit
   *     `PASSWORD_RESET_SENT`, and revoke sessions only if the admin asked. See {@link sendResetLink}.
   *
   * BACK-COMPAT (CLAUDE.md §8). `options` is OPTIONAL and omitting it reproduces the pre-#1268 behavior
   * exactly, so an operator who updates the API before the web build keeps a working Users page. The
   * temp-password outcome is a strict SUPERSET of the old body — `.temporaryPassword` is still there.
   */
  async requestPasswordReset(
    id: string,
    actorId?: string,
    options?: {
      delivery?: AdminPasswordResetDelivery;
      /** `email` delivery only; the temp-password path always revokes. Defaults to false. */
      revokeSessions?: boolean;
      /** Pre-resolved link origin (see `./reset-link-origin`); null → the `origin-unknown` 409. */
      linkOrigin?: string | null;
    },
  ): Promise<AdminPasswordResetOutcome> {
    const user = await this.findOne(id); // 404 if missing or already soft-deleted

    if (!user.isActive) {
      throw new UnprocessableEntityException(
        'Cannot reset the password of an inactive user. Reactivate the account first.',
      );
    }

    // LOCAL mode: lazyit owns the credential (no IdP). Reject a directory-only person (no login by
    // construction — INV: a directoryOnly row never gets a credential via any path, ADR-0086 §5 / #989).
    if (this.isLocalMode()) {
      if (user.directoryOnly) {
        throw new UnprocessableEntityException(
          'This is a directory-only person with no login, so a password cannot be set.',
        );
      }
      if (options?.delivery === 'email') {
        return this.sendResetLink(user, actorId, options);
      }
      const temporaryPassword = this.provisioning.generateTempPassword();
      const credential = await this.provisioning.credentialFields(
        temporaryPassword,
        { mustChangePassword: true },
      );
      // Set the credential AND bump sessionEpoch atomically: the epoch bump revokes every existing session
      // the subject holds (the guard's handleLocal rejects any token minted at a lower epoch), so an admin
      // reset immediately invalidates a possibly-compromised session (ADR-0086 §3 revocation).
      // `revokeSessions` is deliberately NOT honoured here: this path REPLACES passwordHash, so a
      // surviving session would be holding a credential that no longer exists. Revocation is unconditional.
      await this.prisma.user.update({
        where: { id },
        data: {
          ...credential,
          sessionEpoch: { increment: 1 },
          // The MCP connections die with the replaced credential too (ADR-0097 decision 8, amended).
          mcpCredentialEpoch: { increment: 1 },
        },
      });
      this.auditWriteBack('resetPasswordByAdmin', actorId, id, { local: true });
      // Append-only audit (ADR-0086 §5 / decision G): PASSWORD_RESET_BY_ADMIN, actor + subject. No
      // plaintext is ever recorded (the payload carries nothing sensitive).
      await this.recordHistory(
        this.prisma,
        id,
        'PASSWORD_RESET_BY_ADMIN',
        actorId,
      );
      return {
        delivery: 'temporary-password',
        temporaryPassword,
        sessionsRevoked: true,
      };
    }

    throw new PasswordResetUnsupportedError();
  }

  /**
   * The local-mode `email` delivery of {@link requestPasswordReset} (issue #1268): mint a single-use
   * reset link and send it through the instance SMTP (ADR-0079), so the SUBJECT chooses their own
   * password and lazyit never sees a plaintext at all.
   *
   * FAILS LOUDLY, on purpose. The public forgot-password flow is uniform-by-design so it cannot be an
   * account-enumeration oracle; this caller is an authenticated `user:manage` admin who already knows the
   * account exists, so there is no oracle to protect and a silent no-op would deceive the only person who
   * needs the truth. A missing SMTP config or an unresolvable link origin is a 409 carrying the machine-
   * readable `reason` (two different operator fixes), and a relay failure is a 503.
   *
   * ORDERING. The mail is sent BEFORE any write to the user row, so a failed send leaves the account
   * exactly as it was — no half-applied "logged everyone out but sent nothing". Session revocation is
   * therefore only ever reported when it actually happened.
   */
  private async sendResetLink(
    user: User,
    actorId: string | undefined,
    options: { revokeSessions?: boolean; linkOrigin?: string | null },
  ): Promise<AdminPasswordResetOutcome> {
    let sent: { sentTo: string; expiresInMinutes: number };
    try {
      sent = await this.passwordLifecycle.sendAdminResetLink(
        user,
        options.linkOrigin ?? null,
      );
    } catch (err) {
      if (err instanceof AdminResetLinkError) {
        if (err.reason === 'send-failed') {
          // The configuration was there and the relay refused — a transient/operational fault, not a
          // misconfiguration the admin can fix in the dialog. Same 503 class as an IdP write failure.
          throw new ServiceUnavailableException(err.message);
        }
        // `smtp-not-configured` / `origin-unknown`: the instance is not in a state where this delivery
        // can work. 409 with the reason so the UI can point at the exact setting to fix.
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: err.message,
          reason: err.reason,
        });
      }
      throw err;
    }

    // Opt-in revocation (default false). Sending a link does not change the stored credential, so the
    // subject's live sessions are still legitimately theirs — killing them is a deliberate "I think this
    // account is compromised" act, not a side effect of helping someone back in.
    const sessionsRevoked = options.revokeSessions === true;
    if (sessionsRevoked) {
      await this.prisma.user.update({
        where: { id: user.id },
        // A deliberate "this account may be compromised" act: the MCP connections go too (ADR-0097
        // decision 8, amended 2026-09-24).
        data: {
          sessionEpoch: { increment: 1 },
          mcpCredentialEpoch: { increment: 1 },
        },
      });
    }

    this.auditWriteBack('resetPasswordLinkByAdmin', actorId, user.id, {
      local: true,
      sessionsRevoked,
    });
    // Append-only audit: PASSWORD_RESET_SENT (the existing event type — the OIDC branch already emits it
    // for the same meaning: "a reset link went out"), actor = admin, subject = user. Written only AFTER a
    // successful send, so a 409/503 never records a reset that did not happen. No raw token, no plaintext.
    await this.recordHistory(
      this.prisma,
      user.id,
      'PASSWORD_RESET_SENT',
      actorId,
    );

    return {
      delivery: 'email',
      sentTo: sent.sentTo,
      expiresInMinutes: sent.expiresInMinutes,
      sessionsRevoked,
    };
  }

  /**
   * What the admin reset dialog may offer on THIS instance (`GET /users/password-reset-capabilities`,
   * `user:manage`, issue #1268). Resolved server-side so the UI never has to guess from `externalId`
   * (which is null for every local-mode user by construction — the #1268 bug).
   *
   * In OIDC/BYOI everything is false and NO reason is set: emailing a reset link is the identity
   * provider's job, not a lazyit capability that happens to be switched off, so naming an "unavailable
   * reason" would invite an operator to go fix an SMTP setting that would change nothing.
   *
   * `linkOrigin` is resolved by the caller from `WEB_ORIGIN` or (in ADR-0087 LAN mode) the request host —
   * see `./reset-link-origin`.
   */
  async passwordResetCapabilities(
    linkOrigin: string | null,
  ): Promise<PasswordResetCapabilities> {
    if (!this.isLocalMode()) {
      return {
        canResetLocally: false,
        canEmailResetLink: false,
        canMintTemporaryPassword: false,
      };
    }

    const smtpReady = await this.passwordLifecycle.isOutboundEmailReady();
    if (!smtpReady || !linkOrigin) {
      return {
        canResetLocally: true,
        canEmailResetLink: false,
        canMintTemporaryPassword: true,
        // SMTP first: with email off, the origin is moot and telling the admin to set WEB_ORIGIN would
        // send them to the wrong setting.
        emailUnavailableReason: !smtpReady
          ? 'smtp-not-configured'
          : 'origin-unknown',
      };
    }

    return {
      canResetLocally: true,
      canEmailResetLink: true,
      canMintTemporaryPassword: true,
    };
  }

  /**
   * The last-admin predicate (ADR-0040, SEC-021): true when at least one live, active ADMIN OTHER than
   * `userId` exists, i.e. removing `userId`'s administrator powers still leaves the instance
   * administrable. The single definition of "usable admin" — the 409 guard below and the directory-sync
   * offboard skip (ADR-0091) both call it, so the count is never duplicated.
   */
  async hasAnotherActiveAdmin(userId: string): Promise<boolean> {
    const otherAdmins = await this.prisma.user.count({
      where: { role: 'ADMIN', isActive: true, id: { not: userId } },
    });
    return otherAdmins > 0;
  }

  /**
   * Throws 409 Conflict if `userId` is the only remaining usable ADMIN. Used before any action that
   * would remove their administrator powers (role demotion, deactivation, offboarding, delete), so a
   * fresh install — or any instance — is never left without an administrator. Counts LIVE and ACTIVE
   * admins only: the read filter already excludes soft-deleted users, and `isActive: true` excludes
   * deactivated ones, since neither can authenticate to administer anything (SEC-021). The
   * check-then-act window is acceptable for a 5–20-person single-org tool: the worst case is two
   * near-simultaneous demotions both passing, which is the same class of race ADR-0040 already accepts
   * for first-user-ADMIN, and strictly safer than locking everyone out.
   */
  private async assertNotLastAdmin(userId: string) {
    if (!(await this.hasAnotherActiveAdmin(userId))) {
      throw new ConflictException(
        'Cannot remove the last administrator. Promote another user to ADMIN first.',
      );
    }
  }

  /**
   * Soft-delete (offboard) a user. Never hard-delete (auditability is a first principle), but a
   * soft delete alone left the user's access live — the audit gap this closes. In ONE transaction
   * we (1) revoke every active AccessGrant the user holds, (1b) hard-drop every Secret-vault
   * membership the user holds (issue #869 — else a departed user keeps a wrapped-DEK copy and retains
   * cryptographic read access; a SOC2 offboarding-control gap), (2) release every active
   * AssetAssignment (reclaiming the assets) and append a RELEASED asset-history event for each, then
   * (3) stamp `deletedAt`. All-or-nothing: a failure rolls the whole offboarding back, so a user is
   * never left half-offboarded (deleted but still holding grants/assets/vault access, or vice-versa).
   *
   * INV-10 (ADR-0061 §9) is preserved: revoking a vault membership is a PURE ROW-DELETE of wrapped key
   * material — the server never decrypts anything. lazyit CANNOT auto-rotate (it can't re-encrypt), so
   * the result also carries a `rotationVaults` flag (vault name + live item count — pure metadata) as an
   * informational prompt for the operator to rotate those secrets manually.
   *
   * `actor` is the authenticated principal performing the offboarding (from @CurrentPrincipal via the
   * controller). A human is stamped as `revokedById` / `releasedById`; a service account holding
   * `user:manage` is stamped as `revokedBySaId` / `releasedBySaId` so the action stays attributable and
   * the at-most-one-actor CHECK is honored (ADR-0048). Grant revocation is done INLINE here
   * (prisma.accessGrant.updateMany) rather than via the access-grants service, to keep it inside this
   * single transaction.
   *
   * Under OIDC the IdP account is NOT disabled (ADR-0102 §5): the soft delete blocks the person in
   * lazyit (a soft-deleted user's next sign-in is refused), and disabling the IdP account is the
   * operator's step.
   */
  async remove(
    id: string,
    actor: ActorAttribution = {},
  ): Promise<OffboardResult> {
    const target = await this.findOne(id); // 404 if missing or already soft-deleted

    // Last-admin safety guard (ADR-0040): offboarding/deleting the only remaining ADMIN would leave
    // the instance with no administrator (409). Offboarding a non-last admin, or any non-admin, is
    // fine. Mirrors the role-demotion guard in update().
    if (target.role === 'ADMIN') {
      await this.assertNotLastAdmin(id);
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Revoke all the user's active (not-yet-revoked) access grants. Attribute the offboarding
      // actor on each: human → revokedById, service account → revokedBySaId (CHECK-safe; ADR-0048).
      const { count: revokedGrants } = await tx.accessGrant.updateMany({
        where: { userId: id, revokedAt: null },
        data: {
          revokedAt: now,
          ...(actor.userId != null ? { revokedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { revokedBySaId: actor.serviceAccountId }
            : {}),
          notes: 'auto: offboarded',
        },
      });

      // 1b. Revoke the user's Secret-vault crypto memberships (issue #869, SOC2 offboarding control).
      // A departing member otherwise keeps their wrapped-DEK rows and retains cryptographic READ access
      // to every vault they belonged to. INV-10 (ADR-0061 §9) is preserved: revoking a membership is a
      // PURE ROW-DELETE of wrapped key material — the server never decrypts anything.
      //
      // First READ the affected vaults' METADATA (name + live item count — pure metadata, left of the
      // §9 zero-knowledge line), BEFORE the delete, because the rows vanish and this feeds the response's
      // rotation prompt (lazyit can't auto-rotate; the operator rotates those secrets manually).
      const rotationVaults = (
        await tx.vaultMembership.findMany({
          where: { userId: id },
          select: {
            vaultId: true,
            vault: {
              select: {
                name: true,
                _count: { select: { items: { where: { deletedAt: null } } } },
              },
            },
          },
        })
      ).map((m) => ({
        vaultId: m.vaultId,
        name: m.vault.name,
        itemCount: m.vault._count.items,
      }));

      // Then HARD-DROP the rows. VaultMembership is a hard-drop join (no `deletedAt`), so deleteMany is
      // correct — it mirrors the single revoke in SecretManagerService.revokeMembership (ADR-0061 §5:
      // soft revoke = the row ceases to exist).
      const { count: revokedVaultMemberships } =
        await tx.vaultMembership.deleteMany({ where: { userId: id } });

      // Audit parity (in-lane): one MEMBERSHIP_REVOKED SecretAuditLog row per revoked vault, written via a
      // direct createMany — we deliberately do NOT call SecretManagerService, keeping the offboard tx
      // self-contained (lanes disjoint). Attribute the SAME human-vs-SA actor branch the grant revocation
      // uses (a human → actorId, a service account → serviceAccountId); the secret_audit_logs CHECK
      // enforces exactly one actor (ADR-0048). This is the SOC2 "who removed this person's vault access,
      // when" answer, feeding the #871 audit read surface. Skip the write when the user held no membership.
      if (rotationVaults.length > 0) {
        const actorCols =
          actor.userId != null
            ? { actorId: actor.userId }
            : actor.serviceAccountId != null
              ? { serviceAccountId: actor.serviceAccountId }
              : {};
        await tx.secretAuditLog.createMany({
          data: rotationVaults.map((v) => ({
            action: 'MEMBERSHIP_REVOKED' as const,
            vaultId: v.vaultId,
            targetUserId: id,
            ...actorCols,
          })),
        });
      }

      // 2. Release all the user's active asset assignments (+ RELEASED history per asset). The actor is
      // threaded so the releases attribute to the right column (releasedById / releasedBySaId).
      const releasedAssignments = await this.assignments.releaseAllForUser(
        tx,
        id,
        actor,
      );

      // 3. Soft-delete the user, revoking every local session (ADR-0086 §3/§8): the live-filtered guard
      // already refuses a soft-deleted row, but a later restore() would otherwise revive every token minted
      // before the offboarding — including a "keep me signed in" token that never expires by time.
      await tx.user.update({
        where: { id },
        // …and every MCP connection / personal token (ADR-0097 decision 8, amended 2026-09-24).
        data: {
          deletedAt: now,
          sessionEpoch: { increment: 1 },
          mcpCredentialEpoch: { increment: 1 },
        },
      });

      // 4. Append the DELETED history row (DEBT-2, issue #185) inside the SAME transaction, atomic with
      // the soft-delete (ADR-0033). Unlike create/update/reset (human-only @CurrentUser), offboarding
      // attributes the FULL principal — a service account holding user:manage stamps serviceAccountId
      // (CHECK-safe; ADR-0048). The Restrict FK on userId is satisfied: the row references the still-
      // existing (soft-deleted) user. NOTE: the recent_activity view filters soft-deleted subjects, so
      // this DELETED row does not appear in the feed — the offboarding still shows via the released/
      // revoked asset+access branches; the DELETED row remains queryable on the per-user timeline.
      await this.history.record(tx, {
        userId: id,
        eventType: 'DELETED',
        actor,
      });

      return {
        userId: id,
        releasedAssignments,
        revokedGrants,
        revokedVaultMemberships,
        rotationVaults,
      };
    });

    // Drop from the index so soft-deleted users never surface in search (ADR-0035). Outside the tx:
    // fire-and-forget, must never roll back the DB offboarding.
    this.search.remove('users', id);
    return result;
  }

  /**
   * Restore (re-onboard) a soft-deleted user: clear `deletedAt` (ADR-0041). Deliberately does NOT
   * re-grant the access or re-assign the assets that offboarding revoked/released — those are
   * separate, intentional acts; restore only makes the account exist (and log in) again. Found via
   * the `includeSoftDeleted` escape hatch (the read filter would hide it). 404 if it never existed;
   * idempotent if already live. The partial unique index frees `email` on delete, so a restore can
   * 409 if the (case-insensitive) email was reused by another live user in the meantime (mapped by
   * the global PrismaExceptionFilter). Re-indexes for search on success.
   *
   * `actor` (DEBT-2, issue #185) is the principal performing the restore (from @CurrentPrincipal). A
   * RESTORED history row is emitted atomically with clearing `deletedAt`; the idempotent already-live
   * path emits NOTHING (no state change happened).
   */
  async restore(id: string, actor: ActorAttribution = {}) {
    const user = await this.prisma.user.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.UserFindFirstArgs);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    if (user.deletedAt === null) {
      return this.serializeUser(user); // already live — idempotent (no state change → no history row)
    }
    // Clear deletedAt and append the RESTORED history row in ONE transaction (ADR-0033). The subject
    // becomes LIVE again, so this row IS visible in the recent_activity feed (the view keeps live
    // subjects). Attributes the full principal (human → performedById, SA → serviceAccountId).
    const restored = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { deletedAt: null },
      });
      await this.history.record(tx, {
        userId: id,
        eventType: 'RESTORED',
        actor,
      });
      return updated;
    });
    // Re-index the restored user (ADR-0035).
    this.search.upsert('users', projectUser(restored));
    return this.serializeUser(restored);
  }

  // --- clone-with-chosen-actions (ADR-0058 §4) -----------------------------

  /**
   * Clone a user with chosen actions (ADR-0058 §4): mint a NEW user (a normal create), then mirror the
   * SOURCE's selected ACTIVE asset assignments + access grants as NEW append-only rows for the new user.
   * The clone NEVER copies the source's email/legajo/username (unique — the `profile` supplies a new
   * identity) or externalId (never client-settable, SEC-006), and NEVER touches the source's own rows.
   *
   * Semantics:
   *  - The new user is created via the normal {@link create} path (same validation, and a
   *    CREATED UserHistory row carrying `{ clonedFrom, fireWorkflows }` so the provisioning choice is
   *    audited, never silent).
   *  - Selected assignments → NEW AssetAssignment rows (assignedAt=now, actor=the cloning admin),
   *    honouring the one-active-per-(asset,user) live-row guard. A soft-deleted asset, a not-active /
   *    not-found id, or a not-owned-by-source id is SKIPPED and reported. ASSIGNED asset-history is
   *    emitted per row.
   *  - Selected grants → NEW AccessGrant rows (grantedAt=now, actor=admin), accessLevel + expiresAt
   *    copied verbatim. A not-active / not-found / not-owned-by-source grant id, or one whose Application
   *    is soft-deleted ("application_deleted"), is SKIPPED and reported. The ENGINE TOGGLE
   *    (`fireWorkflowsOnClonedGrants`, default false): when TRUE each
   *    grant writes a PENDING workflow run (ACCESS_GRANTED) atomically and is enqueued AFTER commit
   *    (the normal grant path fires); when FALSE the grant is bookkeeping-only (the trigger is
   *    SUPPRESSED). Either way the grant row is identical and auditable.
   *  - The new user's assignments + grants + the workflow run rows commit in ONE transaction; the engine
   *    enqueue happens AFTER commit (the decoupling invariant — a failing provisioning never rolls back
   *    the clone). Returns the per-item batch shape: `{ created, skipped: [{ id, reason }] }`.
   *
   * `:id` (the source) must be LIVE (404 otherwise). `actorId` is the cloning admin (the actor stamped
   * on every cloned assignment/grant + the trigger cause of any fired run).
   */
  async clone(
    sourceId: string,
    data: CloneUser,
    actorId?: string,
  ): Promise<{ created: SerializedUser; skipped: CloneUserResult['skipped'] }> {
    // The source must be a live user (404 otherwise) — you clone a real colleague, never a ghost.
    await this.findOne(sourceId);

    // 1) Mint the new user — a NORMAL create (validation, CREATED history). The CREATED
    //    payload records the provisioning choice (clonedFrom + fireWorkflows) so it is never silent.
    const created = await this.create(data.profile, actorId, {
      createdPayload: {
        clonedFrom: sourceId,
        fireWorkflows: data.fireWorkflowsOnClonedGrants,
      },
    });

    const skipped: CloneUserResult['skipped'] = [];

    // 2) Resolve the SELECTED source assignments — must be the source's ACTIVE rows (releasedAt null).
    //    Anything not found / not the source's / already released is skipped+reported. We then read each
    //    asset's live-state and skip a soft-deleted asset (the live-row guard equivalent), reporting it.
    const assignmentPlans = await this.planClonedAssignments(
      sourceId,
      data.cloneAssetAssignments,
      created.id,
      skipped,
    );

    // 3) Resolve the SELECTED source grants — the source's ACTIVE grants (revokedAt null). For each, if
    //    the engine toggle is ON, pre-plan its ACCESS_GRANTED workflow (a READ, before the tx, swallowed
    //    on failure — the engine can never block the clone). The plan rides into the tx as a PENDING run.
    const grantPlans = await this.planClonedGrants(
      sourceId,
      data.cloneAccessGrants,
      data.fireWorkflowsOnClonedGrants,
      skipped,
    );

    // 4) Write the new user's assignments + grants (+ any PENDING workflow run rows) in ONE transaction —
    //    all-or-nothing among the cloned local rows. The cloning admin is the actor on every row.
    const actor: ActorAttribution = actorId != null ? { userId: actorId } : {};
    const runIds: string[] = [];
    // The cloned grants to nudge the bell about AFTER commit (ADR-0056 §3, issue #359). Collected from
    // the in-tx creates and fired post-commit (best-effort) — never inside the tx (a notification must
    // not roll back the clone), independent of the engine toggle.
    const clonedGrants: {
      id: string;
      userId: string;
      applicationId: string;
      accessLevel: string | null;
    }[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const plan of assignmentPlans) {
        await tx.assetAssignment.create({
          data: {
            assetId: plan.assetId,
            userId: created.id,
            ...(actor.userId != null ? { assignedById: actor.userId } : {}),
          },
        });
        await this.assetHistory.record(tx, {
          assetId: plan.assetId,
          eventType: 'ASSIGNED',
          payload: { userId: created.id },
          actor,
        });
      }
      for (const plan of grantPlans) {
        const grant = await tx.accessGrant.create({
          data: {
            userId: created.id,
            applicationId: plan.applicationId,
            ...(plan.accessLevel != null
              ? { accessLevel: plan.accessLevel }
              : {}),
            ...(plan.expiresAt != null ? { expiresAt: plan.expiresAt } : {}),
            ...(actor.userId != null ? { grantedById: actor.userId } : {}),
          },
        });
        // Remember the grant (with its PERSISTED accessLevel) so the bell fires post-commit on the SAME
        // criteria a hand-created grant uses (ADR-0056 §3, issue #359).
        clonedGrants.push({
          id: grant.id,
          userId: created.id,
          applicationId: grant.applicationId,
          accessLevel: grant.accessLevel,
        });
        // ENGINE TOGGLE: only when ON does a grant carry a workflow plan. The PENDING run row is written
        // atomically with the grant (the same transactional-outbox tradeoff as a hand-created grant);
        // when OFF, `plan.trigger` is null and NO run row is written — the trigger is SUPPRESSED.
        if (plan.trigger) {
          const run = await tx.workflowRun.create({
            data: this.workflowTrigger.buildRunData(
              plan.trigger,
              grant.id,
              actor,
            ),
            select: { id: true },
          });
          runIds.push(run.id);
        }
      }
    });

    // 5) AFTER commit: enqueue every fired run (best-effort; a broker miss leaves it PENDING for the
    //    sweeper). This NEVER rolls back the clone (the decoupling invariant). Empty when the toggle is
    //    off — no run rows were written, so nothing fires.
    for (const runId of runIds) {
      try {
        await this.workflowTrigger.enqueue(runId);
      } catch {
        // The trigger already swallows broker errors; a final guard so the clone result still returns.
      }
    }

    // 6) AFTER commit: fire the in-app notification bell for every cloned grant (ADR-0056 §3, issue
    //    #359), reusing the SAME emitter a hand-created grant uses (admin_granted / critical_app_access,
    //    deduped per grant). Best-effort and INDEPENDENT of the engine toggle — the bell is admin
    //    VISIBILITY, not external provisioning; the emitter already swallows its own errors, and this
    //    guard ensures a thrown emit can never escape into the clone result.
    for (const grant of clonedGrants) {
      try {
        await this.accessGrants.emitGrantNotifications(grant);
      } catch {
        // Best-effort: a failed nudge never affects the already-committed clone.
      }
    }

    return { created, skipped };
  }

  /**
   * Resolve the selected source assignment ids into per-asset clone plans (ADR-0058 §4). Keeps only ids
   * that are the SOURCE's currently-ACTIVE assignments; a not-found / not-source / already-released id is
   * skipped ("not_found"), and an assignment whose asset is soft-deleted is skipped ("asset_deleted") —
   * both reported. De-duplicates by asset so a clone never opens two active assignments for one (asset,
   * new-user) pair (the partial unique index would reject the second anyway).
   */
  private async planClonedAssignments(
    sourceId: string,
    ids: string[],
    newUserId: string,
    skipped: CloneUserResult['skipped'],
  ): Promise<{ assetId: string }[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.assetAssignment.findMany({
      where: { id: { in: ids }, userId: sourceId, releasedAt: null },
      select: { id: true, assetId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Which of the selected asset ids reference a LIVE asset (the read filter hides soft-deleted ones).
    const assetIds = [...new Set(rows.map((r) => r.assetId))];
    const liveAssets = await this.prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true },
    });
    const liveAssetIds = new Set(liveAssets.map((a) => a.id));

    const plans: { assetId: string }[] = [];
    const seenAssets = new Set<string>();
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (!liveAssetIds.has(row.assetId)) {
        // entityId = the underlying asset id so the web resolves a friendly label (the requested id is
        // the ASSIGNMENT id, which the web's asset/app catalogs can't name). #361.
        skipped.push({ id, entityId: row.assetId, reason: 'asset_deleted' });
        continue;
      }
      if (seenAssets.has(row.assetId)) {
        // Two selected assignments on the same asset → one clone row (the second would 409 on the
        // one-active-per-(asset,user) index). Report the duplicate so the result is honest.
        skipped.push({ id, entityId: row.assetId, reason: 'already_in_state' });
        continue;
      }
      seenAssets.add(row.assetId);
      plans.push({ assetId: row.assetId });
    }
    return plans;
  }

  /**
   * Resolve the selected source grant ids into per-grant clone plans (ADR-0058 §4). Keeps only ids that
   * are the SOURCE's currently-ACTIVE grants (revokedAt null); a not-found / not-source / already-revoked
   * id is skipped ("not_found"), and a grant whose Application is soft-deleted is skipped
   * ("application_deleted") — both reported (mirrors the "asset_deleted" guard in
   * {@link planClonedAssignments}). `accessLevel` + `expiresAt` are carried verbatim. When the
   * engine toggle is ON, each plan also pre-resolves its ACCESS_GRANTED workflow `TriggerPlan` (a READ
   * before the tx, swallowed on failure — `trigger` stays null if no workflow / lookup fails); when OFF,
   * `trigger` is always null (the workflow is SUPPRESSED).
   */
  private async planClonedGrants(
    sourceId: string,
    ids: string[],
    fireWorkflows: boolean,
    skipped: CloneUserResult['skipped'],
  ): Promise<
    Array<{
      applicationId: string;
      accessLevel: string | null;
      expiresAt: Date | null;
      trigger: Awaited<
        ReturnType<WorkflowTriggerService['planForTrigger']>
      > | null;
    }>
  > {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.accessGrant.findMany({
      where: { id: { in: ids }, userId: sourceId, revokedAt: null },
      select: {
        id: true,
        applicationId: true,
        accessLevel: true,
        expiresAt: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Which of the selected grants reference a LIVE application (the read filter hides soft-deleted ones)
    // — the same live-state guard planClonedAssignments applies to assets.
    const liveApps = await this.prisma.application.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.applicationId))] } },
      select: { id: true },
    });
    const liveAppIds = new Set(liveApps.map((a) => a.id));

    // When the toggle is on, pre-plan ACCESS_GRANTED once per distinct application (best-effort, before
    // the tx). A null plan = no enabled workflow with a version → bookkeeping-only even when ON.
    const planByApp = new Map<
      string,
      Awaited<ReturnType<WorkflowTriggerService['planForTrigger']>>
    >();
    if (fireWorkflows) {
      const appIds = [...new Set(rows.map((r) => r.applicationId))];
      for (const appId of appIds) {
        const plan = await this.workflowTrigger
          .planForTrigger('ACCESS_GRANTED', appId)
          .catch(() => null);
        planByApp.set(appId, plan);
      }
    }

    const plans: Array<{
      applicationId: string;
      accessLevel: string | null;
      expiresAt: Date | null;
      trigger: Awaited<
        ReturnType<WorkflowTriggerService['planForTrigger']>
      > | null;
    }> = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (!liveAppIds.has(row.applicationId)) {
        // entityId = the underlying application id so the web resolves a friendly label (the requested id
        // is the GRANT id, which the web's asset/app catalogs can't name). Mirrors asset_deleted. #361.
        skipped.push({
          id,
          entityId: row.applicationId,
          reason: 'application_deleted',
        });
        continue;
      }
      plans.push({
        applicationId: row.applicationId,
        accessLevel: row.accessLevel,
        expiresAt: row.expiresAt,
        trigger: fireWorkflows
          ? (planByApp.get(row.applicationId) ?? null)
          : null,
      });
    }
    return plans;
  }
}
