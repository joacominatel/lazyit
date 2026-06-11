import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type {
  CloneUser,
  CloneUserResult,
  CreateUser,
  ManagerDescriptor,
  ManagerInput,
  PageQuery,
  UpdateUser,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma, Role } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { projectUser } from '../search/search.documents';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import type { ActorAttribution } from '../common/actor.service';
import { UserHistoryService } from '../user-history/user-history.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import {
  IDENTITY_PROVIDER,
  PasswordResetUnsupportedError,
  type IdentityProvider,
} from '../auth/identity/identity-provider.interface';

/** The manager-bearing columns a user row carries (ADR-0058) — the subset the read descriptor needs. */
type ManagerColumns = { managerId: string | null; managerName: string | null };

/**
 * The PUBLIC user shape the service returns (ADR-0058): a Prisma `User` row with the raw manager FK
 * columns DROPPED and the resolved `manager` descriptor attached. Timestamps stay Prisma `Date`s here —
 * the API serializes them to the ISO-string wire shape (UserSchema) at the HTTP boundary, exactly like
 * every other endpoint. The controller's `UserDto` / `CloneUserResultDto` document that wire shape.
 */
export type SerializedUser = Omit<User, 'managerId' | 'managerName'> & {
  manager: ManagerDescriptor | null;
};

/**
 * The DB write fragment for the manager either/or (ADR-0058). `managerId` XOR `managerName` (or both
 * null). `undefined` here means "leave both columns untouched" (an update that didn't mention manager).
 */
type ManagerWrite =
  | { managerId: string | null; managerName: string | null }
  | undefined;

/** Optional filters for listing users. */
export interface UserFilters {
  /** Case-insensitive substring over firstName / lastName / email (OR). */
  q?: string;
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
    // IdP write-back seam (ADR-0043). Zitadel mirrors lazyit's user/role decisions; generic-oidc
    // (BYOI) no-ops every management call. Authorization stays DB-first regardless (decision #1).
    @Inject(IDENTITY_PROVIDER)
    private readonly idp: IdentityProvider,
    @InjectPinoLogger(UsersService.name)
    private readonly logger: PinoLogger,
  ) {}

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
    return pageOf(serialized, total, page);
  }

  /** The shared `where` for the user list — used identically by findPage and its count. */
  private buildWhere({ q }: UserFilters): Prisma.UserWhereInput {
    return q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};
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
      ...this.stripManagerColumns(row),
      manager: this.toManagerDescriptor(row, byId),
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

  /**
   * Drop the raw `managerId` / `managerName` columns from a row's wire shape — the descriptor replaces
   * them, and exposing the raw FK would leak a manager id the client has no descriptor for.
   */
  private stripManagerColumns(
    row: User,
  ): Omit<User, 'managerId' | 'managerName'> {
    // Drop the raw FK columns from a shallow copy — the resolved descriptor replaces them on the wire,
    // and leaving `managerId` would leak a manager id the client has no descriptor for.
    const copy: Partial<User> = { ...row };
    delete copy.managerId;
    delete copy.managerName;
    return copy as Omit<User, 'managerId' | 'managerName'>;
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
   */
  async create(
    data: CreateUser,
    actorId?: string,
    opts?: { createdPayload?: Prisma.InputJsonValue },
  ): Promise<SerializedUser> {
    // RBAC default (ADR-0040, flipped to VIEWER by ADR-0043): an omitted role lands the least-
    // privileged read-only role. We set it explicitly here (rather than leaning on the Prisma column
    // default) so the service is the authoritative default for app-created users and the behaviour is
    // testable without a DB. The Users controller is ADMIN-gated, so an ADMIN may still pass any role.
    const role = data.role ?? Role.VIEWER;
    // Resolve the manager either/or → DB columns (ADR-0058). On create there is no subject yet, so no
    // cycle is possible; the FK-live + at-most-one checks still apply. Then build the explicit create
    // data (manager/legajo/username are columns; `manager` the input union is NOT — strip + translate).
    const managerWrite = await this.resolveManagerWrite(data.manager, null);
    const createData = this.buildProfileCreateData(data, role, managerWrite);
    // DB-first + mirror (ADR-0043 §3): create the LOCAL row first, then mirror into the IdP. If the
    // mirror fails we must NOT leave a split-brain (local user exists, IdP missing) — so we compensate
    // by removing the just-created local row and surface the Management failure as 503. This is the one
    // place a hard delete is correct: the row was created microseconds ago in THIS request, is not yet
    // referenced by anything, and was never visible to a reader — a soft delete would leave a ghost.
    const user = await this.prisma.user.create({ data: createData });

    try {
      const ref = await this.idp.createUser({
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role,
      });
      this.auditWriteBack('createUser', actorId, user.id, {
        email: user.email,
        role,
      });
      // Zitadel returns the real user id; persist it as externalId so future grants/deactivate target
      // the managed user. BYOI returns an empty ref (no IdP user) — leave externalId null in that case.
      // The externalId update and the CREATED history row commit in ONE transaction so the user's first
      // audited state and its log row land atomically (ADR-0033). History is emitted only on the SUCCESS
      // path — never before the IdP mirror could still fail and trigger the hard-delete compensation
      // (the UserHistory.userId Restrict FK would otherwise block that rollback).
      if (this.idp.supportsManagement && ref.externalId) {
        const linked = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.user.update({
            where: { id: user.id },
            data: { externalId: ref.externalId },
          });
          await this.recordHistory(
            tx,
            user.id,
            'CREATED',
            actorId,
            opts?.createdPayload,
          );
          return updated;
        });
        this.search.upsert('users', projectUser(linked));
        return this.serializeUser(linked);
      }
    } catch (err) {
      // Compensate: roll the local create back so local and Zitadel never disagree (no split-brain).
      await this.compensateLocalCreate(user.id);
      this.logger.error(
        { op: 'createUser', actor: actorId, subjectUserId: user.id },
        `IdP write-back failed on create; rolled back local user (${err instanceof Error ? err.message : String(err)})`,
      );
      throw err;
    }

    // BYOI / no-management path: the IdP mirror has already succeeded (or no-opped), so the user row is
    // durable and will NOT be compensated — emit the CREATED history row now (the Restrict FK is safe).
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

  /**
   * Roll back a just-created local user when the IdP mirror failed (no-split-brain compensation). A
   * HARD delete is correct here: the row was created in this same request, is unreferenced, and was
   * never returned to a caller, so deleting it leaves no audit/FK orphan (unlike the soft-delete used
   * for genuine offboarding). Best-effort: a delete failure is logged but the original 503 still wins.
   */
  private async compensateLocalCreate(userId: string): Promise<void> {
    try {
      await this.prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      this.logger.error(
        { op: 'compensateLocalCreate', subjectUserId: userId },
        `failed to roll back local user after IdP write-back failure (${err instanceof Error ? err.message : String(err)})`,
      );
    }
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
      // Never strip the LAST remaining ADMIN of its role — that would leave the instance with no
      // administrator and no way to recover from the UI (409). Demoting any other admin is fine.
      if (current.role === 'ADMIN' && data.role !== 'ADMIN') {
        await this.assertNotLastAdmin(id);
      }
    }

    const roleChanged = data.role !== undefined && data.role !== current.role;
    // Profile edits an ADMIN can mirror (issue #149). A field only counts as CHANGED when it is present
    // AND differs from the stored value — so a PATCH that resends the same name/email skips the IdP
    // round-trip. `email` is already normalized (trim+lowercase, citext) by the schema (ADR-0041).
    const nameChanged =
      (data.firstName !== undefined && data.firstName !== current.firstName) ||
      (data.lastName !== undefined && data.lastName !== current.lastName);
    const emailChanged =
      data.email !== undefined && data.email !== current.email;
    const profileChanged = nameChanged || emailChanged;

    // Resolve the manager either/or → DB columns (ADR-0058): validates the FK is live, rejects a
    // self-manager and a CYCLE (DFS up the chain, with `id` as the subject). `undefined` when manager
    // wasn't in the PATCH (leave the columns untouched). The manager is LOCAL-only — NOT mirrored to the
    // IdP — so it sits outside the role/profile IdP write-back/revert block below.
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
    const user = await this.prisma.user.update({
      where: { id },
      data: { ...scalarData, ...(managerWrite ?? {}) },
    });

    // Mirror role and/or profile CHANGES to the IdP (ADR-0043 §3, issue #149). Only when the user is
    // IdP-linked (externalId set) — a local-only row has nothing to mirror. The Zitadel mirror is a
    // best-effort, eventually-consistent multi-call (grantRole / a profile-name PUT / a committed-LAST
    // email POST). If ANY mirror fails we compensate by reverting the local row to its pre-update values
    // (role + name + email) and surface the failure as 503, then make a best-effort attempt to converge
    // the one sub-resource that could have committed ahead of the failure — the display name (see the
    // catch). The account-linking email is committed LAST so it never diverges; a mid-sequence display-
    // name/role divergence is transient and has zero authZ impact (authorization is DB-first, INV-5 /
    // ADR-0043 #1). BYOI no-ops grantRole/updateUser → no throw, so this path is Zitadel-only in practice.
    if ((roleChanged || profileChanged) && current.externalId) {
      try {
        if (roleChanged) {
          await this.idp.grantRole(current.externalId, data.role!);
          this.auditWriteBack('grantRole', actorId, id, {
            from: current.role,
            to: data.role,
            externalId: current.externalId,
          });
        }
        if (profileChanged) {
          // externalId (sub) is UNCHANGED — updates the existing Zitadel user, never a re-link
          // (SEC-006). Email is written PRE-VERIFIED by the adapter, so it never forces re-verification.
          await this.idp.updateUser(current.externalId, {
            // PUT /v2/users/human/{id} is a full-replace on the profile resource — givenName is
            // required even when only familyName changed. Always send both name fields when any name
            // changed: new value if it differs, current stored value if not (issue #219).
            ...(nameChanged
              ? {
                  firstName: data.firstName ?? current.firstName,
                  lastName: data.lastName ?? current.lastName,
                }
              : {}),
            ...(emailChanged ? { email: data.email } : {}),
          });
          this.auditWriteBack('updateUser', actorId, id, {
            // Log WHICH fields changed (the new email is not a secret); never the old values.
            firstName: nameChanged ? data.firstName : undefined,
            lastName: nameChanged ? data.lastName : undefined,
            email: emailChanged ? data.email : undefined,
            externalId: current.externalId,
          });
        }
      } catch (err) {
        // Revert ONLY the fields this update could have changed, back to their pre-update truth, so
        // local and Zitadel agree (the previous values are authoritative) without touching untouched
        // columns. role → role; name → firstName/lastName; email → email. The manager (ADR-0058) is
        // local-only (never mirrored) but it was applied in the SAME prisma.user.update above, so on an
        // IdP failure it must be rolled back to its pre-update value too — otherwise a failed PATCH that
        // bundled a manager change would silently leave the new manager while reverting everything else.
        const reverted = await this.prisma.user.update({
          where: { id },
          data: {
            ...(roleChanged ? { role: current.role } : {}),
            ...(nameChanged
              ? { firstName: current.firstName, lastName: current.lastName }
              : {}),
            ...(emailChanged ? { email: current.email } : {}),
            ...(managerChanged
              ? {
                  managerId: current.managerId,
                  managerName: current.managerName,
                }
              : {}),
          },
        });
        this.search.upsert('users', projectUser(reverted));
        // Best-effort convergence (INV-5): the Zitadel mirror is multi-call — a profile name `PUT`
        // followed by a committed-LAST email `POST`. If the profile PUT already committed the NEW name
        // but a later sub-call (the email POST) then failed, Zitadel's display name is now NEW while we
        // just reverted the local row to OLD — a bounded, cosmetic display-name divergence with ZERO
        // authZ impact (authorization is DB-first, ADR-0043 #1). Re-mirror the reverted (current) name
        // back to Zitadel so the two stores converge instead of drifting permanently. The account-
        // linking email needs no such re-mirror: it is committed LAST, so on its failure Zitadel's email
        // was never touched and already matches the reverted local row. This is a SEPARATE best-effort
        // attempt in its OWN try/catch — it only LOGS on failure and NEVER throws over the original
        // error, so the caller still receives the original 503.
        if (nameChanged && current.externalId) {
          try {
            await this.idp.updateUser(current.externalId, {
              firstName: current.firstName,
              lastName: current.lastName,
            });
          } catch (mirrorErr) {
            this.logger.error(
              { op: 'updateUser', actor: actorId, subjectUserId: id },
              `best-effort name re-mirror failed after revert; Zitadel display name may transiently diverge until the next edit (no authZ impact, DB-first) (${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)})`,
            );
          }
        }
        this.logger.error(
          { op: 'updateUser', actor: actorId, subjectUserId: id },
          `IdP write-back failed on update; reverted local user to its prior state (${err instanceof Error ? err.message : String(err)})`,
        );
        throw err;
      }
    }

    // Emit UserHistory (DEBT-2, issue #185) only on the SUCCESS path — after any IdP mirror has
    // committed, so a reverted update never produces a misleading log row. A role change, a manager
    // change and a profile edit can all happen in one PATCH, so emit each that fired (a ROLE_CHANGED
    // carries { from, to }; a MANAGER_CHANGED carries { from, to } where each side is a user-id |
    // external-name | null; an UPDATED carries which fields changed). Atomic in one transaction with the
    // durable final state (ADR-0033).
    if (roleChanged || managerChanged || profileChanged) {
      await this.prisma.$transaction(async (tx) => {
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
        if (profileChanged) {
          await this.recordHistory(tx, id, 'UPDATED', actorId, {
            // WHICH fields changed (never the old/new values — the email is not a secret, but keep the
            // log shape consistent with the IdP write-back audit line: field names only).
            fields: [
              ...(nameChanged ? (['name'] as const) : []),
              ...(emailChanged ? (['email'] as const) : []),
            ],
          });
        }
      });
    }

    this.search.upsert('users', projectUser(user));
    return this.serializeUser(user);
  }

  /**
   * Trigger a password reset for a user (issue #149). lazyit NEVER stores, sets or sends a password
   * (ADR-0016/0037) — it asks the IdP to do it: Zitadel emails a reset link via ZITADEL's own SMTP.
   *
   * Guards (in order): 404 if the user is missing or soft-deleted (findOne filters those out), 422 if
   * the user is INACTIVE (`isActive=false`) — a disabled account is not invited to set a new password
   * until it is reactivated — and an honest 501 (PasswordResetUnsupportedError) for a local-only row
   * with no `externalId`: there is no IdP identity to reset, so we never pretend an email went out.
   *
   * BYOI (generic OIDC) cannot trigger a reset on a foreign IdP: the provider throws
   * PasswordResetUnsupportedError, which the controller maps to a 501 "managed by your identity
   * provider" (INV-4). A Zitadel Management failure surfaces as 503 (consistent with the other writes).
   * Audited via a structured log line AND, since DEBT-2 (issue #185), an append-only UserHistory row
   * (PASSWORD_RESET_SENT) emitted only after the IdP call SUCCEEDS — so a 422/501/503 never logs a
   * reset that did not go out.
   */
  async requestPasswordReset(id: string, actorId?: string): Promise<void> {
    const user = await this.findOne(id); // 404 if missing or already soft-deleted

    if (!user.isActive) {
      throw new UnprocessableEntityException(
        'Cannot reset the password of an inactive user. Reactivate the account first.',
      );
    }
    if (!user.externalId) {
      // No IdP identity to reset — honest 501 (same shape BYOI returns), never a misleading 2xx.
      throw new PasswordResetUnsupportedError(
        'This user is not linked to an identity provider, so a password reset cannot be triggered.',
      );
    }

    await this.idp.requestPasswordReset(user.externalId);
    this.auditWriteBack('requestPasswordReset', actorId, id, {
      externalId: user.externalId,
    });
    // Append the PASSWORD_RESET_SENT history row (DEBT-2, issue #185) AFTER the IdP call succeeded —
    // a failed/unsupported reset above already threw, so this only ever records a reset that went out.
    await this.recordHistory(this.prisma, id, 'PASSWORD_RESET_SENT', actorId);
  }

  /**
   * Throws 409 Conflict if `userId` is the only remaining live ADMIN. Used before any action that
   * would remove their administrator powers (role demotion, offboarding, delete), so a fresh install
   * — or any instance — is never left without an administrator. Counts LIVE admins only (the read
   * filter already excludes soft-deleted users), so an offboarded admin doesn't count toward the
   * total. The check-then-act window is acceptable for a 5–20-person single-org tool: the worst case
   * is two near-simultaneous demotions both passing, which is the same class of race ADR-0040 already
   * accepts for first-user-ADMIN, and strictly safer than locking everyone out.
   */
  private async assertNotLastAdmin(userId: string) {
    const otherAdmins = await this.prisma.user.count({
      where: { role: 'ADMIN', id: { not: userId } },
    });
    if (otherAdmins === 0) {
      throw new ConflictException(
        'Cannot remove the last administrator. Promote another user to ADMIN first.',
      );
    }
  }

  /**
   * Soft-delete (offboard) a user. Never hard-delete (auditability is a first principle), but a
   * soft delete alone left the user's access live — the audit gap this closes. In ONE transaction
   * we (1) revoke every active AccessGrant the user holds, (2) release every active AssetAssignment
   * (reclaiming the assets) and append a RELEASED asset-history event for each, then (3) stamp
   * `deletedAt`. All-or-nothing: a failure rolls the whole offboarding back, so a user is never left
   * half-offboarded (deleted but still holding grants/assets, or vice-versa).
   *
   * `actor` is the authenticated principal performing the offboarding (from @CurrentPrincipal via the
   * controller). A human is stamped as `revokedById` / `releasedById`; a service account holding
   * `user:manage` is stamped as `revokedBySaId` / `releasedBySaId` so the action stays attributable and
   * the at-most-one-actor CHECK is honored (ADR-0048). Grant revocation is done INLINE here
   * (prisma.accessGrant.updateMany) rather than via the access-grants service, to keep it inside this
   * single transaction. The IdP write-back JSON audit line still uses the human actor id (a structured
   * log, not a DB FK column).
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
      // 0. Deactivate the user in the IdP FIRST, inside the transaction (ADR-0043 §2c). A Management
      // failure throws here and rolls the ENTIRE offboarding back — so we never end up with a
      // soft-deleted-local / still-active-in-Zitadel split-brain (the failure surfaces as 503). For an
      // IdP-linked user only; a local-only row (externalId null) has nothing to deactivate. BYOI
      // no-ops deactivateUser → no throw, offboarding proceeds locally exactly as before.
      if (target.externalId) {
        await this.idp.deactivateUser(target.externalId);
        this.auditWriteBack('deactivateUser', actor.userId, id, {
          externalId: target.externalId,
        });
      }

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

      // 2. Release all the user's active asset assignments (+ RELEASED history per asset). The actor is
      // threaded so the releases attribute to the right column (releasedById / releasedBySaId).
      const releasedAssignments = await this.assignments.releaseAllForUser(
        tx,
        id,
        actor,
      );

      // 3. Soft-delete the user.
      await tx.user.update({ where: { id }, data: { deletedAt: now } });

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

      return { userId: id, releasedAssignments, revokedGrants };
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
   *  - The new user is created via the normal {@link create} path (same validation, IdP mirror, and a
   *    CREATED UserHistory row carrying `{ clonedFrom, fireWorkflows }` so the provisioning choice is
   *    audited, never silent).
   *  - Selected assignments → NEW AssetAssignment rows (assignedAt=now, actor=the cloning admin),
   *    honouring the one-active-per-(asset,user) live-row guard. A soft-deleted asset, a not-active /
   *    not-found id, or a not-owned-by-source id is SKIPPED and reported. ASSIGNED asset-history is
   *    emitted per row.
   *  - Selected grants → NEW AccessGrant rows (grantedAt=now, actor=admin), accessLevel + expiresAt
   *    copied verbatim. The ENGINE TOGGLE (`fireWorkflowsOnClonedGrants`, default false): when TRUE each
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

    // 1) Mint the new user — a NORMAL create (validation, IdP mirror, CREATED history). The CREATED
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
        skipped.push({ id, reason: 'asset_deleted' });
        continue;
      }
      if (seenAssets.has(row.assetId)) {
        // Two selected assignments on the same asset → one clone row (the second would 409 on the
        // one-active-per-(asset,user) index). Report the duplicate so the result is honest.
        skipped.push({ id, reason: 'already_in_state' });
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
   * id is skipped ("not_found") and reported. `accessLevel` + `expiresAt` are carried verbatim. When the
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
