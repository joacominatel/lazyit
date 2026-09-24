import { Injectable, Logger } from '@nestjs/common';
import type {
  Prisma,
  ServiceAccount,
  User,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  resolveServiceAccountPermissions,
  ungrantableServiceAccountGrants,
} from '../service-accounts/service-account-permissions';
import type { HumanPrincipal, ServicePrincipal } from './principal';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a principal could not be loaded. Callers map it to their own (usually generic) 401. */
export type PrincipalLoadFailure =
  | 'not_found'
  | 'session_revoked'
  | 'inactive'
  | 'directory_only'
  | 'revoked'
  | 'expired';

export type PrincipalLoadResult<P> =
  | { ok: true; principal: P }
  | { ok: false; reason: PrincipalLoadFailure };

/**
 * DB-FIRST principal re-load (INV-1), shared by every path that turns an identity into a principal:
 *   - `JwtAuthGuard.handleLocal` — a local session token's `sub` + `epoch`;
 *   - the {@link ServiceAccountAuthenticator} — a verified `lzit_sa_` token's account row;
 *   - `JwtAuthGuard`'s delegated-identity branch — an in-process AI tool call (ADR-0097, R1).
 *
 * Sharing one implementation is what makes the delegated branch refuse EXACTLY what the network
 * branches refuse (route equivalence, INV-AI-2): a soft-deleted, inactive or directory-only user, a
 * `sessionEpoch` mismatch, and a revoked, inactive or expired service account.
 */
@Injectable()
export class PrincipalLoaderService {
  private readonly logger = new Logger(PrincipalLoaderService.name);
  /**
   * Service accounts already reported as carrying inert SA-ungrantable grants, so the warning is logged
   * once per account per process. Only the log is de-duplicated: authorization stays DB-first (INV-1).
   */
  private readonly warnedInertGrants = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Re-load a human by id on the LIVE-filtered client (an offboarded, soft-deleted row is invisible →
   * `not_found`), then refuse, in this order: a `sessionEpoch` other than `expectedEpoch` (revocation —
   * logout, password change, deactivation and admin reset bump it), an inactive account, and a
   * directory-only person (no login capability by construction).
   */
  loadHuman(
    userId: string,
    expectedEpoch: number,
  ): Promise<PrincipalLoadResult<HumanPrincipal>> {
    return this.loadHumanAt(userId, 'sessionEpoch', expectedEpoch);
  }

  /**
   * {@link loadHuman} for an MCP credential (an OAuth grant or a personal MCP token): identical gates,
   * but the revocation counter compared is `mcpCredentialEpoch` — the grant's snapshot — instead of
   * `sessionEpoch`, so a normal web logout leaves the credential alive (ADR-0097 decision 8, amended
   * 2026-09-24). Password change / reset, admin reset, deactivation and offboarding bump both counters.
   */
  loadHumanForMcpCredential(
    userId: string,
    expectedMcpCredentialEpoch: number,
  ): Promise<PrincipalLoadResult<HumanPrincipal>> {
    return this.loadHumanAt(
      userId,
      'mcpCredentialEpoch',
      expectedMcpCredentialEpoch,
    );
  }

  private async loadHumanAt(
    userId: string,
    counter: 'sessionEpoch' | 'mcpCredentialEpoch',
    expectedEpoch: number,
  ): Promise<PrincipalLoadResult<HumanPrincipal>> {
    // A non-uuid id must never reach the uuid column (a would-be 500); it cannot name a user anyway.
    if (!UUID_REGEX.test(userId)) {
      return { ok: false, reason: 'not_found' };
    }
    const user: User | null = await this.prisma.user.findFirst({
      where: { id: userId },
    });
    if (!user) {
      return { ok: false, reason: 'not_found' };
    }
    if (user[counter] !== expectedEpoch) {
      return { ok: false, reason: 'session_revoked' };
    }
    if (!user.isActive) {
      return { ok: false, reason: 'inactive' };
    }
    if (user.directoryOnly) {
      return { ok: false, reason: 'directory_only' };
    }
    return { ok: true, principal: { kind: 'human', user } };
  }

  /**
   * Re-load a service account by id, INCLUDING soft-deleted rows so a revoked account is seen and
   * refused rather than missed, then apply {@link serviceAccountPrincipal}.
   */
  async loadServiceAccount(
    serviceAccountId: string,
  ): Promise<PrincipalLoadResult<ServicePrincipal>> {
    const account =
      await this.findServiceAccountIncludingRevoked(serviceAccountId);
    if (!account) {
      return { ok: false, reason: 'not_found' };
    }
    return this.serviceAccountPrincipal(account);
  }

  /**
   * Look a service account up by id including soft-deleted rows (the ADR-0032 escape hatch the
   * soft-delete extension strips), so revocation is detected, never mistaken for "unknown".
   */
  findServiceAccountIncludingRevoked(
    serviceAccountId: string,
  ): Promise<ServiceAccount | null> {
    return this.prisma.serviceAccount.findFirst({
      where: { id: serviceAccountId },
      includeSoftDeleted: true,
    } as Prisma.ServiceAccountFindFirstArgs);
  }

  /**
   * The account-state gates and the grant resolution for an already-identified account row: refuse a
   * revoked (soft-deleted), inactive or expired account, then resolve its DIRECT grants DB-first into
   * the principal's permission set — never a token claim, never a role.
   */
  async serviceAccountPrincipal(
    account: ServiceAccount,
  ): Promise<PrincipalLoadResult<ServicePrincipal>> {
    if (account.deletedAt !== null) {
      return { ok: false, reason: 'revoked' };
    }
    if (!account.isActive) {
      return { ok: false, reason: 'inactive' };
    }
    if (
      account.expiresAt !== null &&
      account.expiresAt.getTime() <= Date.now()
    ) {
      return { ok: false, reason: 'expired' };
    }
    const grantRows = await this.prisma.serviceAccountPermission.findMany({
      where: { serviceAccountId: account.id },
      select: { permission: true },
    });
    this.warnInertGrants(account, grantRows);
    return {
      ok: true,
      principal: {
        kind: 'service',
        serviceAccount: account,
        permissions: resolveServiceAccountPermissions(grantRows),
      },
    };
  }

  /**
   * SEC-073: a grant row for an SA-ungrantable verb (INV-SA-3) persisted before the SEC-011 write-time
   * refinement is stripped by the resolver and confers nothing. It is not deleted (audit trail intact);
   * the next admin save of the grant set drops it. Tell the operator once, naming the account and the
   * verbs only.
   */
  private warnInertGrants(
    account: ServiceAccount,
    grantRows: readonly { permission: string }[],
  ): void {
    if (this.warnedInertGrants.has(account.id)) return;
    const inert = ungrantableServiceAccountGrants(grantRows);
    if (inert.length === 0) return;
    this.warnedInertGrants.add(account.id);
    this.logger.warn(
      `Service account ${account.id} ("${account.name}") carries SA-ungrantable grants that are ignored: ` +
        `${inert.join(', ')}. Re-save its permissions to remove them (SEC-073).`,
    );
  }
}
