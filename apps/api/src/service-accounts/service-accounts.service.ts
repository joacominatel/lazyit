import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreateServiceAccount,
  type Permission,
  type ServiceAccount as ServiceAccountWire,
  type ServiceAccountWithSecret,
  type UpdateServiceAccount,
  PERMISSIONS,
  SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS,
} from '@lazyit/shared';
import type {
  Prisma as PrismaTypes,
  ServiceAccount,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EngineServiceAccountService } from '../workflow-engine/engine-service-account.service';
import { mintToken, randomHash } from './service-account-token';

/** A ServiceAccount row joined with its permission grants — the shape every read/write returns. */
type ServiceAccountWithPermissions = ServiceAccount & {
  permissions: { permission: string }[];
};

/** The include that joins the permission grants onto a ServiceAccount row. */
const WITH_PERMISSIONS = {
  permissions: { select: { permission: true } },
} satisfies PrismaTypes.ServiceAccountInclude;

/**
 * Service Accounts management backend (ADR-0048). Owns the ADMIN-gated CRUD + token lifecycle for
 * non-human principals:
 *   - {@link create}  — mint a service account + its first token (returned ONCE), audit MINT.
 *   - {@link findAll} / {@link findOne} — list / read (never the secret; tokenPrefix only).
 *   - {@link update}  — rename / description / isActive / expiresAt / replace the grant set; audit a
 *     PERMISSION_CHANGE when the grants changed.
 *   - {@link rotate}  — mint a NEW secret (old invalidated), returned ONCE; audit ROTATE.
 *   - {@link revoke}  — soft-delete (= revoke); audit REVOKE.
 *   - {@link restore} — un-delete; audit RESTORE.
 *
 * Every mutation appends an immutable {@link ServiceAccountAuditLog} row attributed to the acting ADMIN
 * (ADR-0006). The cleartext secret is NEVER persisted (only its SHA-256 hash) and NEVER logged or
 * audited. The grant set is validated against the frozen `@lazyit/shared` catalog at the edge (zod) and
 * defensively re-filtered here, so a catalog-foreign literal can never be persisted as a grant.
 *
 * SYSTEM-MANAGED (issue #304): the singleton, auto-provisioned engine SA (reserved name
 * {@link EngineServiceAccountService.ENGINE_SA_NAME}) that every workflow run EXECUTES AS (ADR-0048 /
 * ADR-0054 §6) is LOCKED here: {@link update}, {@link rotate} and {@link revoke} reject it with a 409 so
 * a human can never rename it, change its grants, disable it (isActive=false), invalidate its token, or
 * soft-delete it out from under a run. It is identified by the reserved NAME (single source of truth on
 * {@link EngineServiceAccountService}), never a magic string duplicated here, and surfaced to the UI via
 * the {@link ServiceAccountWire.systemManaged} flag so the client gates its controls without hardcoding
 * the name. (Its existence is additionally self-healed by `getOrCreate()` on next engine use.)
 */
@Injectable()
export class ServiceAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a service account and mint its first token (ADR-0048). The token embeds the row id
   * (lzit_sa_<id>_<secret>), so the row is created FIRST (Prisma allocates the cuid), then the token is
   * minted from `account.id` and the hash/prefix are written back — all inside ONE transaction, so a
   * service account is never persisted without a usable token. The cleartext is returned ONCE on the
   * response and never again. `expiresAt` is rejected if it is in the past.
   */
  async create(
    dto: CreateServiceAccount,
    actorId: string | null,
  ): Promise<ServiceAccountWithSecret> {
    const expiresAt =
      dto.expiresAt !== undefined
        ? this.parseFutureExpiry(dto.expiresAt)
        : null;
    const permissions = this.cleanPermissions(dto.permissions);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1) Create the row so Prisma allocates the cuid the token must embed. The placeholder tokenHash
      //    is a FRESH RANDOM value (not a constant), so two overlapping creates can't collide on the
      //    partial-unique tokenHash index; it is overwritten with the real hash in step 3 before commit
      //    and never authenticates anything (no secret hashes to it).
      const draft = await tx.serviceAccount.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          tokenHash: randomHash(),
          tokenPrefix: '',
          expiresAt,
          createdById: actorId,
          permissions: {
            create: permissions.map((permission) => ({ permission })),
          },
        },
      });
      // 2) Mint the token from the real id.
      const minted = mintToken(draft.id);
      // 3) Write the real hash/prefix back.
      const account = await tx.serviceAccount.update({
        where: { id: draft.id },
        data: { tokenHash: minted.tokenHash, tokenPrefix: minted.tokenPrefix },
        include: WITH_PERMISSIONS,
      });
      await tx.serviceAccountAuditLog.create({
        data: {
          serviceAccountId: account.id,
          action: 'MINT',
          actorId,
          detail: { permissions },
        },
      });
      return { account, token: minted.token };
    });

    // The ONLY place the cleartext token is returned. The caller must store it now.
    return { ...this.toWire(result.account), token: result.token };
  }

  /**
   * List service accounts (ADR-0048). The soft-delete read filter hides revoked accounts by default;
   * `includeRevoked` (ADMIN, via the controller) shows them too. Never returns a secret.
   */
  async findAll(includeRevoked = false): Promise<ServiceAccountWire[]> {
    const rows = await this.prisma.serviceAccount.findMany({
      include: WITH_PERMISSIONS,
      orderBy: { createdAt: 'desc' },
      ...(includeRevoked
        ? ({ includeSoftDeleted: true } as Record<string, unknown>)
        : {}),
    });
    return rows.map((r) => this.toWire(r));
  }

  /** A single service account by id (404 if missing or revoked). Never returns a secret. */
  async findOne(id: string): Promise<ServiceAccountWire> {
    return this.toWire(await this.getLiveOr404(id));
  }

  /**
   * Update a service account (ADR-0048): rename, edit description, toggle isActive, change expiresAt,
   * and/or REPLACE the grant set wholesale. Applied in one transaction; when the grant set changed, the
   * revoked/added permissions are diffed and a PERMISSION_CHANGE audit row records the delta. The
   * token/secret are never touched here (rotate is separate).
   */
  async update(
    id: string,
    dto: UpdateServiceAccount,
    actorId: string | null,
  ): Promise<ServiceAccountWire> {
    // 404 if missing or revoked (the read filter excludes soft-deleted rows).
    const account = await this.getLiveOr404(id);
    // The engine SA is system-managed — its name/grants/isActive/expiry are never human-editable (#304).
    this.assertNotSystemManaged(account, 'edited');

    const data: PrismaTypes.ServiceAccountUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.expiresAt !== undefined) {
      data.expiresAt =
        dto.expiresAt === null ? null : this.parseFutureExpiry(dto.expiresAt);
    }

    const nextPermissions =
      dto.permissions !== undefined
        ? this.cleanPermissions(dto.permissions)
        : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.serviceAccount.update({ where: { id }, data });
      }

      if (nextPermissions !== undefined) {
        const currentRows = await tx.serviceAccountPermission.findMany({
          where: { serviceAccountId: id },
          select: { permission: true },
        });
        const current = new Set(currentRows.map((r) => r.permission));
        const next = new Set<string>(nextPermissions);
        const toRevoke = [...current].filter((p) => !next.has(p));
        const toGrant = [...next].filter((p) => !current.has(p));

        if (toRevoke.length > 0) {
          await tx.serviceAccountPermission.deleteMany({
            where: { serviceAccountId: id, permission: { in: toRevoke } },
          });
        }
        if (toGrant.length > 0) {
          await tx.serviceAccountPermission.createMany({
            data: toGrant.map((permission) => ({
              serviceAccountId: id,
              permission,
            })),
          });
        }
        if (toRevoke.length > 0 || toGrant.length > 0) {
          await tx.serviceAccountAuditLog.create({
            data: {
              serviceAccountId: id,
              action: 'PERMISSION_CHANGE',
              actorId,
              detail: {
                added: toGrant,
                removed: toRevoke,
              },
            },
          });
        }
      }

      return tx.serviceAccount.findFirstOrThrow({
        where: { id },
        include: WITH_PERMISSIONS,
      });
    });

    return this.toWire(updated);
  }

  /**
   * Rotate the token (ADR-0048): mint a NEW secret, replace the stored hash/prefix (invalidating the
   * old token immediately), and return the new cleartext ONCE. Audited as ROTATE. The id (and thus the
   * token's id segment) is unchanged.
   */
  async rotate(
    id: string,
    actorId: string | null,
  ): Promise<ServiceAccountWithSecret> {
    const account = await this.getLiveOr404(id);
    // The engine SA's token is a throwaway it never authenticates with — rotating it is meaningless and
    // forbidden (#304).
    this.assertNotSystemManaged(account, 'rotated');
    const minted = mintToken(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const account = await tx.serviceAccount.update({
        where: { id },
        data: { tokenHash: minted.tokenHash, tokenPrefix: minted.tokenPrefix },
        include: WITH_PERMISSIONS,
      });
      await tx.serviceAccountAuditLog.create({
        data: { serviceAccountId: id, action: 'ROTATE', actorId },
      });
      return account;
    });

    return { ...this.toWire(updated), token: minted.token };
  }

  /**
   * Revoke a service account (ADR-0048): a SOFT delete (stamp deletedAt). Its token stops authenticating
   * immediately (the guard rejects a soft-deleted account). Idempotent-ish: 404 if it was never live.
   * Audited as REVOKE.
   */
  async revoke(
    id: string,
    actorId: string | null,
  ): Promise<ServiceAccountWire> {
    const account = await this.getLiveOr404(id);
    // The engine SA must always exist as the run actor — soft-deleting it would break every run (#304).
    this.assertNotSystemManaged(account, 'revoked');
    const updated = await this.prisma.$transaction(async (tx) => {
      const account = await tx.serviceAccount.update({
        where: { id },
        data: { deletedAt: new Date() },
        include: WITH_PERMISSIONS,
      });
      await tx.serviceAccountAuditLog.create({
        data: { serviceAccountId: id, action: 'REVOKE', actorId },
      });
      return account;
    });
    return this.toWire(updated);
  }

  /**
   * Restore a revoked service account (ADR-0048): clear deletedAt. Finds the row via the
   * includeSoftDeleted escape hatch (the read filter would hide it), 404s if it never existed, and is
   * idempotent if already live. Its EXISTING token resumes working (rotate separately to invalidate it).
   * Audited as RESTORE.
   */
  async restore(
    id: string,
    actorId: string | null,
  ): Promise<ServiceAccountWire> {
    const account = await this.prisma.serviceAccount.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as PrismaTypes.ServiceAccountFindFirstArgs);
    if (!account) {
      throw new NotFoundException(`Service account ${id} not found`);
    }
    if (account.deletedAt === null) {
      return this.findOne(id); // already live — idempotent
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const restored = await tx.serviceAccount.update({
        where: { id },
        data: { deletedAt: null },
        include: WITH_PERMISSIONS,
      });
      await tx.serviceAccountAuditLog.create({
        data: { serviceAccountId: id, action: 'RESTORE', actorId },
      });
      return restored;
    });
    return this.toWire(updated);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Fetch a LIVE service account (with grants) or 404. The read filter already excludes revoked rows. */
  private async getLiveOr404(
    id: string,
  ): Promise<ServiceAccountWithPermissions> {
    const account = await this.prisma.serviceAccount.findFirst({
      where: { id },
      include: WITH_PERMISSIONS,
    });
    if (!account) {
      throw new NotFoundException(`Service account ${id} not found`);
    }
    return account;
  }

  /**
   * Project a DB row (+ its grants) to the shared `ServiceAccount` wire shape. NEVER includes the
   * secret or the tokenHash — only the non-secret tokenPrefix. Dates → ISO strings; grants → a flat,
   * catalog-sorted permission array.
   */
  private toWire(row: ServiceAccountWithPermissions): ServiceAccountWire {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      tokenPrefix: row.tokenPrefix,
      isActive: row.isActive,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      permissions: this.sortedCatalog(row.permissions.map((p) => p.permission)),
      // System-managed = the engine-owned singleton (#304). The UI gates its row controls off this.
      systemManaged: ServiceAccountsService.isSystemManaged(row),
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  }

  /**
   * Is this row the system-managed engine SA? Identified by the RESERVED NAME — the single source of
   * truth on {@link EngineServiceAccountService}, not a magic string duplicated here (#304). The engine
   * SA is the singleton named row a workflow run executes as; locking it keeps the run actor immutable.
   */
  static isSystemManaged(row: { name: string }): boolean {
    return row.name === EngineServiceAccountService.ENGINE_SA_NAME;
  }

  /**
   * Throw a 409 if the row is the system-managed engine SA (#304). `verb` is the attempted operation
   * (e.g. "edited", "rotated", "revoked") so the error reads naturally for the operator.
   */
  private assertNotSystemManaged(row: { name: string }, verb: string): void {
    if (ServiceAccountsService.isSystemManaged(row)) {
      throw new ConflictException(
        `The "${EngineServiceAccountService.ENGINE_SA_NAME}" service account is system-managed ` +
          `(the workflow engine executes as it) and cannot be ${verb}.`,
      );
    }
  }

  /**
   * Keep only catalog literals and sort by catalog order (a stable, reviewable shape; mirrors the
   * permission-config service). The zod DTO already validated membership; this is the defensive
   * DB-read filter — a stray DB row can never surface a permission the code doesn't know.
   */
  private sortedCatalog(perms: readonly string[]): Permission[] {
    const order = (p: Permission) => PERMISSIONS.indexOf(p);
    const valid = perms.filter((p): p is Permission =>
      (PERMISSIONS as readonly string[]).includes(p),
    );
    return [...new Set(valid)].sort((a, b) => order(a) - order(b));
  }

  /**
   * Dedupe + catalog-filter the desired grant set before persisting (the zod DTO already validated).
   * Also defensively strips the INV-SA-3 ungrantable verbs (belt-and-suspenders for any non-DTO code
   * path — the schema refinement is Layer 1; this is the persistence-time backstop). SEC-011.
   */
  private cleanPermissions(perms: readonly string[]): Permission[] {
    return this.sortedCatalog(perms).filter(
      (p) =>
        !(SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS as readonly string[]).includes(
          p,
        ),
    );
  }

  /** Parse an ISO expiry string and reject a past instant (400). */
  private parseFutureExpiry(iso: string): Date {
    const when = new Date(iso);
    if (when.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    return when;
  }
}
