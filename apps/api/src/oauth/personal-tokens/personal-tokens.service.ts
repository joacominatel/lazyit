import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OAuthScopeSchema,
  PERSONAL_TOKEN_PREFIX,
  type CreatePersonalToken,
  type OAuthGrant,
  type OAuthScope,
  type PersonalTokenCreated,
} from '@lazyit/shared';
import type { Prisma, User } from '../../../generated/prisma/client';
import { resolveMcpAuthMode } from '../../ai/status/ai-status.service';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import type { HumanPrincipal } from '../../auth/principal';
import { PrismaService } from '../../prisma/prisma.service';
import { toOAuthGrantWire } from '../grants.service';
import { hashOpaqueToken, mintOpaqueToken, safeEqual } from '../oauth-crypto';
import { OAuthAuditService } from '../oauth-audit.service';
import { OAuthPolicyService } from '../oauth-policy.service';
import { OAuthSubjectService } from '../oauth-subject.service';
import { OAuthTokenService } from '../oauth-token.service';
import { GRANT_LAST_USED_THROTTLE_MS } from '../oauth.constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const CUID_REGEX = /^c[a-z0-9]{20,32}$/;

/**
 * The audience a personal token is bound to. A `lan` instance has no pinned origin (ADR-0087: the host is
 * whatever the browser used), so the audience is the one route personal tokens are accepted on, not a
 * URL built from `Host`. It keeps a personal grant from ever matching an OAuth grant's canonical resource.
 */
export const PERSONAL_TOKEN_RESOURCE = '/mcp';

/** At most this many live personal tokens per user (a bounded credential surface). */
export const MAX_LIVE_PERSONAL_TOKENS = 20;

/** Why a personal token was refused at `/mcp`, and the HTTP status to answer with. */
export type PersonalTokenFailureReason =
  | 'malformed'
  | 'unavailable'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'wrong_audience'
  | 'not_found'
  | 'session_revoked'
  | 'inactive'
  | 'directory_only'
  | 'password_change_required'
  | 'mcp_disabled'
  | 'forbidden';

/** A verified personal token — the same shape `/mcp` builds its caller from for an OAuth token. */
export interface VerifiedPersonalToken {
  ok: true;
  principal: HumanPrincipal;
  grant: {
    id: string;
    /** Personal tokens have no OAuth client. */
    clientId: null;
    /** The token's label, shown where a client name would be. */
    clientName: string | null;
    scopes: OAuthScope[];
    createdAt: Date;
  };
  expiresAt: Date;
}

export type PersonalTokenVerification =
  | VerifiedPersonalToken
  | { ok: false; reason: PersonalTokenFailureReason; status: 401 | 403 };

/** Why personal tokens cannot be minted here. The web explains each one (CEO: "La UI debería detectarlo"). */
export type PersonalTokenRefusal = 'AI_DISABLED' | 'OAUTH_INSTANCE';

function refused(code: PersonalTokenRefusal, message: string) {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code,
    message,
  });
}

function storedScopes(values: readonly string[]): OAuthScope[] {
  return values.flatMap((value) => {
    const parsed = OAuthScopeSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Personal MCP tokens (`lzit_pat_…`) — the `lan` instance's way to connect an agent, where OAuth cannot
 * run (ADR-0097 decision 9, default 14; mcp-and-oauth.md §5.4; synthesis §4.8, R7):
 *   - minted only when the instance has NO HTTPS authorization server (the `personal-token` MCP auth mode
 *     `/ai/status` reports), MCP is switched on and the caller is a human holding `ai:connect`;
 *   - a personal token is a grant of kind `personal` plus one token row of kind `personal`: the same
 *     connected-apps list and the same one revocation path ({@link OAuthTokenService.revokeGrant});
 *   - 32 CSPRNG bytes, only the SHA-256 is stored, the cleartext appears in exactly one response and is
 *     never logged; the expiry is mandatory (90 days by default, 365 at most);
 *   - it dies with the user exactly like an OAuth grant: the grant snapshots `sessionEpoch`, and the
 *     `/mcp` check re-loads the user DB-first (deactivation, offboarding, password change, sign out
 *     everywhere, forced password change) and re-reads `ai:connect` and the MCP switch on every request;
 *   - it is accepted ONLY on `/mcp` (the REST guard refuses it by construction — no JWT, no SA shape).
 */
@Injectable()
export class PersonalTokensService {
  private readonly logger = new Logger(PersonalTokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: OAuthPolicyService,
    private readonly subjects: OAuthSubjectService,
    private readonly principals: PrincipalLoaderService,
    private readonly tokens: OAuthTokenService,
    private readonly audit: OAuthAuditService,
  ) {}

  /** Whether this instance serves personal tokens at all (not HTTPS OAuth, not the shim). */
  static available(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.AUTH_MODE !== 'shim' && resolveMcpAuthMode(env) !== 'oauth';
  }

  /* ── create / list / revoke (the owner's session) ───────────────────────────────────────────────── */

  async create(
    user: User,
    input: CreatePersonalToken,
    ctx: { ip?: string | null } = {},
  ): Promise<PersonalTokenCreated> {
    if (process.env.AUTH_MODE === 'shim') {
      throw refused('AI_DISABLED', 'AI is not available on this instance.');
    }
    if (!PersonalTokensService.available()) {
      throw refused(
        'OAUTH_INSTANCE',
        'This instance uses OAuth for AI agents: connect the agent with its sign-in flow instead of a personal token.',
      );
    }
    const settings = await this.policy.mcpSettings();
    if (!settings.mcpEnabled) {
      throw refused(
        'AI_DISABLED',
        'External AI agents (MCP) are turned off on this instance.',
      );
    }
    // The route already required `ai:connect` and a human session; re-read the account state DB-first.
    const subject = await this.subjects.loadEligible(user.id);
    if (!subject) {
      throw new ForbiddenException(
        'Your account cannot connect AI agents right now.',
      );
    }

    const now = new Date();
    const live = await this.prisma.oAuthGrant.count({
      where: {
        userId: subject.id,
        kind: 'personal',
        deletedAt: null,
        sessionEpoch: subject.sessionEpoch,
        expiresAt: { gt: now },
      },
    });
    if (live >= MAX_LIVE_PERSONAL_TOKENS) {
      throw new ConflictException(
        `You already have ${MAX_LIVE_PERSONAL_TOKENS} active personal tokens. Revoke one you no longer use first.`,
      );
    }

    const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
    const scopes = storedScopes(input.scopes);
    const minted = mintOpaqueToken(PERSONAL_TOKEN_PREFIX);

    const grant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.oAuthGrant.create({
        data: {
          userId: subject.id,
          kind: 'personal',
          clientRefId: null,
          label: input.label,
          scopes,
          resource: PERSONAL_TOKEN_RESOURCE,
          sessionEpoch: subject.sessionEpoch,
          expiresAt,
        },
      });
      await tx.oAuthToken.create({
        data: {
          grantId: created.id,
          kind: 'personal',
          tokenHash: minted.hash,
          expiresAt,
        },
      });
      await this.audit.record(
        {
          action: 'PERSONAL_TOKEN_CREATED',
          userId: subject.id,
          actorId: subject.id,
          grantId: created.id,
          ip: ctx.ip,
          // Never the token or its hash.
          detail: {
            label: input.label,
            scopes,
            expiresAt: expiresAt.toISOString(),
          },
        },
        tx,
      );
      return created;
    });

    return {
      token: minted.value,
      grant: toOAuthGrantWire({ ...grant, client: null }),
    };
  }

  /**
   * The caller's live personal tokens (not revoked, not expired, bound to the current `sessionEpoch`).
   * Available whatever the instance mode and switch, so a user can always see and revoke what exists.
   */
  async listMine(user: User): Promise<OAuthGrant[]> {
    const rows = await this.prisma.oAuthGrant.findMany({
      where: {
        userId: user.id,
        kind: 'personal',
        deletedAt: null,
        sessionEpoch: user.sessionEpoch,
        expiresAt: { gt: new Date() },
      },
      include: { client: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toOAuthGrantWire);
  }

  /** Revoke one of the caller's OWN personal tokens; anything else (another user's, an OAuth grant) is 404. */
  async revokeMine(
    user: User,
    grantId: string,
    ctx: { ip?: string | null } = {},
  ): Promise<void> {
    if (!CUID_REGEX.test(grantId)) throw new NotFoundException();
    const grant = await this.prisma.oAuthGrant.findFirst({
      where: {
        id: grantId,
        userId: user.id,
        kind: 'personal',
        deletedAt: null,
      },
    });
    if (!grant) throw new NotFoundException();
    await this.tokens.revokeGrant(grant.id, 'user', user.id, {
      userId: user.id,
      clientId: null,
      ip: ctx.ip,
      personal: true,
    });
  }

  /* ── resource-server verification (`/mcp`) ───────────────────────────────────────────────────── */

  /**
   * Verify a personal token presented at `/mcp`, DB-first on every request: token hash → personal token
   * row (unexpired) → grant (live, personal, audience, unexpired) → user re-loaded (live, active, not
   * directory-only, `sessionEpoch` equal to the grant's snapshot, no forced password change) → MCP switch
   * → `ai:connect` held NOW. On an HTTPS OAuth instance a personal token is refused outright
   * (`unavailable`): OAuth is the only path there (CEO, round 2).
   */
  async verify(token: string): Promise<PersonalTokenVerification> {
    const fail = (
      reason: PersonalTokenFailureReason,
      status: 401 | 403 = 401,
    ): PersonalTokenVerification => ({ ok: false, reason, status });

    if (!token.startsWith(PERSONAL_TOKEN_PREFIX)) return fail('malformed');
    if (!PersonalTokensService.available()) return fail('unavailable');

    const presentedHash = hashOpaqueToken(token);
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: presentedHash },
      include: { grant: true },
    });
    if (
      !row ||
      row.kind !== 'personal' ||
      !safeEqual(row.tokenHash, presentedHash)
    ) {
      return fail('invalid');
    }
    const now = Date.now();
    const { grant } = row;
    if (!grant || grant.kind !== 'personal') return fail('invalid');
    if (grant.deletedAt !== null) return fail('revoked');
    if (
      row.expiresAt.getTime() <= now ||
      grant.expiresAt === null ||
      grant.expiresAt.getTime() <= now
    ) {
      return fail('expired');
    }
    if (grant.resource !== PERSONAL_TOKEN_RESOURCE) {
      return fail('wrong_audience');
    }

    const loaded = await this.principals.loadHuman(
      grant.userId,
      grant.sessionEpoch,
    );
    if (!loaded.ok) return fail(loaded.reason);
    const { user } = loaded.principal;
    if (user.mustChangePassword) return fail('password_change_required');

    const settings = await this.policy.mcpSettings();
    if (!settings.mcpEnabled) return fail('mcp_disabled', 403);
    if (!(await this.subjects.holdsConnect(user))) {
      return fail('forbidden', 403);
    }

    this.stampLastUsed(grant.id, grant.lastUsedAt);
    return {
      ok: true,
      principal: loaded.principal,
      grant: {
        id: grant.id,
        clientId: null,
        clientName: grant.label,
        scopes: storedScopes(grant.scopes),
        createdAt: grant.createdAt,
      },
      expiresAt: grant.expiresAt,
    };
  }

  /** Fire-and-forget, throttled `lastUsedAt` stamp (the OAuth grant and service-account precedent). */
  private stampLastUsed(grantId: string, lastUsedAt: Date | null): void {
    const now = Date.now();
    if (
      lastUsedAt !== null &&
      now - lastUsedAt.getTime() < GRANT_LAST_USED_THROTTLE_MS
    ) {
      return;
    }
    const data: Prisma.OAuthGrantUpdateManyMutationInput = {
      lastUsedAt: new Date(now),
    };
    this.prisma.oAuthGrant
      .updateMany({ where: { id: grantId, deletedAt: null }, data })
      .catch((err: unknown) => {
        this.logger.warn(
          `Could not stamp lastUsedAt on personal token grant ${grantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
