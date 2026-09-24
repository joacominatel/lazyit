import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OAuthGrantKindSchema,
  OAuthScopeSchema,
  type OAuthGrant,
} from '@lazyit/shared';
import type {
  OAuthClient,
  OAuthGrant as OAuthGrantRow,
  User,
} from '../../generated/prisma/client';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { redirectHost } from './client-policy';
import { OAuthTokenService } from './oauth-token.service';

type GrantWithClient = OAuthGrantRow & { client: OAuthClient | null };

/** The admin listing adds whose connection it is (the shared `OAuthGrant` has no owner field). */
export type AdminOAuthGrant = OAuthGrant & { userId: string };

const CUID_REGEX = /^c[a-z0-9]{20,32}$/;

/** Map a row to the connected-apps wire shape (`OAuthGrantSchema`). Never carries a token or hash. */
export function toOAuthGrantWire(grant: GrantWithClient): OAuthGrant {
  const kind = OAuthGrantKindSchema.safeParse(grant.kind);
  const firstRedirect = grant.client?.redirectUris[0];
  return {
    id: grant.id,
    kind: kind.success ? kind.data : 'oauth',
    client: grant.client
      ? { name: grant.client.name, verified: grant.client.kind !== 'dcr' }
      : null,
    label: grant.label,
    redirectHost: firstRedirect ? redirectHost(firstRedirect) : null,
    scopes: grant.scopes.flatMap((scope) => {
      const parsed = OAuthScopeSchema.safeParse(scope);
      return parsed.success ? [parsed.data] : [];
    }),
    createdAt: grant.createdAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
  };
}

/**
 * "Connected apps" (R9): a user's own delegations and, for admins, everyone's — with revoke. Only LIVE
 * grants are listed: not revoked (soft-deleted), not expired, and still bound to the user's current
 * `mcpCredentialEpoch` (a grant from before a password change is already dead and would only confuse; a
 * web logout does not move that counter, so it leaves the list intact — ADR-0097 decision 8, amended).
 *
 * These endpoints stay available while MCP is switched off and on `lan`, so an admin can always revoke
 * during an incident and personal tokens (W3-4) share the same list.
 */
@Injectable()
export class GrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
    private readonly tokens: OAuthTokenService,
  ) {}

  async listMine(user: User): Promise<OAuthGrant[]> {
    const rows = await this.prisma.oAuthGrant.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        mcpCredentialEpoch: user.mcpCredentialEpoch,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { client: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toOAuthGrantWire);
  }

  async listForAdmin(userId: string | undefined): Promise<AdminOAuthGrant[]> {
    const rows = await this.prisma.oAuthGrant.findMany({
      where: {
        ...(userId ? { userId } : {}),
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        user: { deletedAt: null },
      },
      include: { client: true, user: { select: { mcpCredentialEpoch: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows
      .filter((row) => row.mcpCredentialEpoch === row.user.mcpCredentialEpoch)
      .map((row) => ({ ...toOAuthGrantWire(row), userId: row.userId }));
  }

  /**
   * Revoke a grant: its owner may always revoke it (reducing one's own delegation needs no permission);
   * anyone else needs `settings:manage`. A grant the caller may not see answers 404, not 403, so the
   * endpoint reveals nothing about other users' connections.
   */
  async revoke(
    actor: User,
    grantId: string,
    ip?: string | null,
  ): Promise<void> {
    if (!CUID_REGEX.test(grantId)) throw new NotFoundException();
    const grant = await this.prisma.oAuthGrant.findFirst({
      where: { id: grantId, deletedAt: null },
      include: { client: true },
    });
    if (!grant) throw new NotFoundException();
    const isOwner = grant.userId === actor.id;
    if (!isOwner) {
      const granted = await this.permissions.resolve(actor.role);
      if (!granted.has('settings:manage')) throw new NotFoundException();
    }
    await this.tokens.revokeGrant(
      grant.id,
      isOwner ? 'user' : 'admin',
      actor.id,
      {
        userId: grant.userId,
        clientId: grant.client?.clientId ?? null,
        ip,
        personal: grant.kind === 'personal',
      },
    );
  }
}
