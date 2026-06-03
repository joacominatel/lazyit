import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import {
  Prisma,
  Role,
  type ServiceAccount,
  type User,
} from '../../generated/prisma/client';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { Principal } from './principal';
import {
  isServiceAccountToken,
  parseToken,
  verifySecret,
} from '../service-accounts/service-account-token';
import { resolveServiceAccountPermissions } from '../service-accounts/service-account-permissions';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subset of OIDC userinfo / standard claims used for JIT provisioning. */
interface ProfileClaims {
  email?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  [key: string]: unknown;
}

/**
 * Global auth guard (ADR-0038, extended for service accounts by ADR-0048).
 *
 * SERVICE-ACCOUNT branch (ADR-0048) — runs FIRST, in every mode: a `Bearer lzit_sa_<id>_<secret>`
 *   token authenticates a NON-HUMAN principal. The id is looked up in the DB (including soft-deleted
 *   rows so a revoked account is detected), the secret is constant-time-compared to the stored SHA-256
 *   `tokenHash`, and a revoked / inactive / expired account is rejected — all as a generic 401. On
 *   success it sets `request.serviceAccount` + `request.principal = {kind:'service', …}` (with the
 *   direct grants resolved DB-first) and leaves `request.user` undefined (a service account is never a
 *   human). Any other bearer (or none) falls through to the unchanged human auth below.
 *
 * AUTH_MODE=shim (dev/test) — reads X-User-Id header; resolves user by UUID; never 401s.
 *   Present + valid UUID → user set on request; absent → request.user = undefined (anonymous).
 *
 * OIDC mode (production default) — validates Bearer JWT against the JWKS endpoint of
 *   OIDC_ISSUER. JIT-provisions a User on first login (externalId = sub). Missing/invalid
 *   token → 401 UnauthorizedException. On the JIT path the guard enriches the profile from the
 *   standard OIDC userinfo endpoint (ADR-0038): an OAuth access token carries authorization, not
 *   identity, so email/name claims must be fetched from userinfo. The userinfo endpoint is located
 *   via OIDC Discovery (BYOI-safe; no vendor path hardcoding) and the lookup is fail-soft — any
 *   discovery/userinfo failure falls back to the token's claims, never breaking login.
 *
 * After a HUMAN path resolves a user, the guard mirrors it onto `request.principal = {kind:'human', …}`
 * so the authorization guard + ActorService treat both kinds of caller uniformly. The JWKS RemoteKeySet
 * is created once at module scope (jose caches keys internally).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  // Lazily initialized on first use so startup succeeds even when OIDC_ISSUER is unset in shim mode.
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  // Resolved once via OIDC Discovery and cached for the app lifetime (like `jwks`), so repeated
  // JIT provisions do not re-run discovery. Null = not yet resolved (or last resolution failed).
  private userinfoEndpoint: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Routes flagged with @Public() bypass auth entirely (e.g. the health probes). A method-level
    // decorator overrides a class-level one (getAllAndOverride).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      Request & {
        user?: User;
        serviceAccount?: ServiceAccount;
        principal?: Principal;
      }
    >();

    // SERVICE-ACCOUNT branch (ADR-0048) — runs BEFORE the human modes. A lazyit-native token
    // (`Authorization: Bearer lzit_sa_...`) authenticates a non-human principal in EVERY mode (it has
    // no IdP dependency, BYOI-safe), so it is checked first. Any other bearer (or none) falls through
    // to the unchanged human auth (shim or OIDC). The SA branch sets request.principal itself.
    const bearer = this.extractBearer(request);
    if (bearer && isServiceAccountToken(bearer)) {
      return this.handleServiceAccount(request, bearer);
    }

    const result =
      process.env.AUTH_MODE === 'shim'
        ? await this.handleShim(request)
        : await this.handleOidc(request);

    // Unify the human principal (ADR-0048): every existing path still sets request.user; mirror it onto
    // request.principal so the authorization guard + ActorService can read either kind uniformly. An
    // anonymous shim request (no resolved user) leaves principal undefined.
    request.principal = request.user
      ? { kind: 'human', user: request.user }
      : undefined;
    return result;
  }

  /** The raw bearer value (after `Bearer `), or undefined when the header is absent / non-bearer. */
  private extractBearer(request: Request): string | undefined {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return undefined;
    }
    return authHeader.slice(7);
  }

  // ---------- service-account mode (ADR-0048) -------------------------------

  /**
   * Authenticate a service account from a lazyit-native token (ADR-0048). DB-FIRST (INV-1): everything
   * is verified against the DB row, never a token claim.
   *   1. Parse `lzit_sa_<id>_<secret>`; a malformed token → 401.
   *   2. Look the ServiceAccount up BY ID, INCLUDING soft-deleted rows (the escape hatch), so a
   *      revoked (deletedAt) account is detected and REJECTED rather than silently re-provisioned.
   *   3. Constant-time compare SHA-256(secret) to the row's `tokenHash`. A wrong secret → 401. The
   *      lookup-then-compare order means a token with a real id but wrong secret still 401s, and a
   *      token for an unknown id 401s without a compare.
   *   4. Reject (401) a revoked (deletedAt), inactive (isActive=false) or expired (expiresAt past) account.
   *   5. Resolve its direct permission grants DB-first into a Set and set `request.principal`
   *      (kind:'service') + `request.serviceAccount`. `request.user` stays undefined — a service
   *      account is NEVER a human (it never enters the user directory, JIT or last-admin logic).
   *
   * Every rejection is a generic 401 ("Invalid service-account token") — it never reveals WHICH check
   * failed (unknown id vs. wrong secret vs. revoked), avoiding an account-enumeration oracle.
   */
  private async handleServiceAccount(
    request: Request & {
      user?: User;
      serviceAccount?: ServiceAccount;
      principal?: Principal;
    },
    bearer: string,
  ): Promise<boolean> {
    const invalid = () =>
      new UnauthorizedException('Invalid service-account token');

    const parsed = parseToken(bearer);
    if (!parsed) {
      throw invalid();
    }

    // Look up INCLUDING soft-deleted rows: a revoked account must be SEEN here (so we 401), not missed
    // by the read filter. The flag is the ADR-0032 escape hatch the soft-delete extension strips.
    const account = await this.prisma.serviceAccount.findFirst({
      where: { id: parsed.serviceAccountId },
      includeSoftDeleted: true,
    } as Prisma.ServiceAccountFindFirstArgs);

    // No row for that id → 401 WITHOUT a secret compare. (We still parsed a well-formed token.)
    if (!account) {
      throw invalid();
    }

    // Constant-time secret check FIRST (before leaking state via the revoked/expired branches): a
    // caller who doesn't hold the secret can't distinguish "wrong secret" from "revoked" — both 401.
    if (!verifySecret(parsed.secret, account.tokenHash)) {
      throw invalid();
    }

    // Account-state gates (all 401, generic): revoked (soft-deleted), disabled, or expired.
    if (account.deletedAt !== null) {
      throw invalid();
    }
    if (!account.isActive) {
      throw invalid();
    }
    if (
      account.expiresAt !== null &&
      account.expiresAt.getTime() <= Date.now()
    ) {
      throw invalid();
    }

    // Resolve the direct grants DB-first (INV-1) into a clean catalog Set — never a token claim.
    const grantRows = await this.prisma.serviceAccountPermission.findMany({
      where: { serviceAccountId: account.id },
      select: { permission: true },
    });
    const permissions = resolveServiceAccountPermissions(grantRows);

    request.serviceAccount = account;
    request.principal = {
      kind: 'service',
      serviceAccount: account,
      permissions,
    };
    request.user = undefined;

    // Best-effort last-used stamp (fire-and-forget): never blocks or fails the request. Uses the base
    // client; a write failure is swallowed (the audit/auth decision is already made).
    void this.prisma.serviceAccount
      .update({ where: { id: account.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }

  // ---------- shim mode -----------------------------------------------------

  private async handleShim(
    request: Request & { user?: User },
  ): Promise<boolean> {
    const rawId = (request.headers['x-user-id'] as string | undefined)?.trim();
    if (!rawId) {
      request.user = undefined;
      return true;
    }
    if (!UUID_REGEX.test(rawId)) {
      // Invalid UUID format → treat as anonymous (same as absent) to avoid breaking existing dev
      // tooling; the old ActorService threw 400 but a global guard must not 400 on a missing user.
      request.user = undefined;
      return true;
    }
    const user = await this.prisma.user.findFirst({ where: { id: rawId } });
    // Soft-deleted users are filtered by the Prisma extension, so findFirst returns null for them.
    // A disabled (isActive=false) account is treated as anonymous in shim mode: the shim never 401s
    // (its whole posture is "missing/invalid actor → anonymous"), so a deactivated user must not keep
    // an authenticated context either.
    request.user = user && user.isActive ? user : undefined;
    return true;
  }

  // ---------- OIDC mode -----------------------------------------------------

  private async handleOidc(
    request: Request & { user?: User },
  ): Promise<boolean> {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = authHeader.slice(7);

    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) {
      throw new UnauthorizedException(
        'OIDC_ISSUER is not configured on the server',
      );
    }

    // Lazy-init the JWKS key set (one per app lifetime; jose caches fetched keys).
    if (!this.jwks) {
      const jwksUri =
        process.env.OIDC_JWKS_URI ?? `${issuer}/.well-known/jwks.json`;
      // When JWKS is fetched from an internal Docker URL, Zitadel still resolves its instance
      // from the forwarded host. Inject X-Forwarded-* derived from the external issuer so the
      // fetch reaches the right instance (otherwise Zitadel returns 404 "Instance not found").
      const headers = this.forwardedHeaders(issuer);
      const options = headers ? { headers } : undefined;
      this.jwks = createRemoteJWKSet(new URL(jwksUri), options);
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer,
        // Pin the signature algorithm to RS256 so a token can never be verified under a weaker or
        // attacker-chosen `alg` (alg-confusion / "none" downgrade). Zitadel signs OIDC tokens RS256.
        algorithms: ['RS256'],
        // audience validation: omit if OIDC_CLIENT_ID is unset so the guard does not fail when
        // access tokens carry a resource audience rather than the client id.
        ...(process.env.OIDC_CLIENT_ID
          ? { audience: process.env.OIDC_CLIENT_ID }
          : {}),
      }));
    } catch {
      throw new UnauthorizedException('Invalid or expired Bearer token');
    }

    const sub = payload.sub;
    if (!sub) {
      throw new UnauthorizedException('Token is missing the sub claim');
    }

    // JIT provision: upsert the User row on first login (ADR-0038). The access token is passed
    // so the JIT path can enrich the profile from the OIDC userinfo endpoint (the token itself
    // carries authorization, not identity).
    const user = await this.jitProvision(sub, token, payload);

    // Enforce account state: a deactivated lazyit account must lose API access even while its IdP
    // token is still live (broken-offboarding fix). The JIT path never returns a soft-deleted user
    // (it 403s instead), so only the active flag is checked here.
    if (!user.isActive) {
      throw new UnauthorizedException('Account disabled');
    }

    request.user = user;
    return true;
  }

  /**
   * JIT provisioning (ADR-0038). The lookup INCLUDES soft-deleted rows so offboarding sticks:
   *  - a live User with `externalId = sub` → returned as-is (no discovery / userinfo call);
   *  - a *soft-deleted* User with that sub → 403 (do NOT re-provision): re-creating a fresh row
   *    would silently resurrect an offboarded account and orphan its old User.id audit links;
   *  - no row by externalId → first login: enrich the access token's claims with the OIDC userinfo
   *    profile (the access token alone lacks email/name), then ACCOUNT-LINK BY EMAIL before creating:
   *    if a LIVE user already holds the (normalized) email and is UNCLAIMED (externalId IS NULL), bind
   *    this sub onto that row and inherit its role (this is how the seeded ADMIN is adopted by the
   *    operator's IdP identity). If that email is already linked to a DIFFERENT sub, 409 (never steal
   *    an account). Otherwise create a fresh User: sub → externalId, email, given_name + family_name →
   *    firstName/lastName (falls back to splitting `name`, then the email local-part).
   *
   * The create is a real upsert on the `externalId` unique key (was a check-then-act findFirst+create
   * race): parallel first-login requests for the same fresh token can no longer both create and
   * collide on the unique constraint with an intermittent 500. The email-link claim is likewise
   * race-safe (guarded updateMany + refetch).
   */
  private async jitProvision(
    sub: string,
    accessToken: string,
    claims: JWTPayload,
  ): Promise<User> {
    // includeSoftDeleted: bypass the soft-delete read filter so an offboarded user is still seen
    // here. Without it the filtered findFirst returns null and the guard would JIT-re-provision a
    // brand-new row, resurrecting the account. The flag is a custom arg the Prisma extension strips
    // (soft-delete.extension.ts), so it is not part of the generated type — hence the local cast.
    const existing = await this.prisma.user.findFirst({
      where: { externalId: sub },
      includeSoftDeleted: true,
    } as Prisma.UserFindFirstArgs);
    if (existing) {
      if (existing.deletedAt !== null) {
        throw new ForbiddenException('Account has been deactivated');
      }
      return existing;
    }

    // RBAC bootstrap (ADR-0040; default flipped to VIEWER by ADR-0043): the FIRST user ever
    // provisioned becomes ADMIN, so a fresh install is never left without anyone able to administer
    // it; every later JIT user defaults to VIEWER (least-privilege read-only, uniform with app-created
    // users) until an ADMIN promotes them. "Ever provisioned" counts soft-deleted rows too
    // (includeSoftDeleted) — once any user has existed, a fresh row is no longer "the first", so an
    // offboarded-then-reprovisioned install cannot silently hand ADMIN to the next signup. The
    // check-then-create window is acceptable: it only matters on a truly empty DB, and the worst case
    // (two genuinely-concurrent first logins) makes both ADMIN — strictly safer than locking everyone
    // out, and an ADMIN can demote.
    const userCount = await this.prisma.user.count({
      includeSoftDeleted: true,
    } as Prisma.UserCountArgs);
    const role: Role = userCount === 0 ? Role.ADMIN : Role.VIEWER;

    // First login: the OIDC access token carries authorization, not identity, so fetch the real
    // profile from the userinfo endpoint and merge it OVER the token claims. Fail-soft — on any
    // failure `fetchUserinfo` returns null and we provision from the token claims alone.
    const userinfo = await this.fetchUserinfo(accessToken);
    const profile: ProfileClaims = { ...claims, ...(userinfo ?? {}) };

    const emailClaim =
      typeof profile['email'] === 'string' ? profile['email'] : undefined;
    // Normalize (trim + lowercase) so the JIT-provisioned email matches the citext column and the
    // @lazyit/shared EmailSchema (ADR-0041). Without this, an IdP that returns "Bob@x" would store a
    // mixed-case row that the case-insensitive unique index still treats as "bob@x" — fine for
    // uniqueness, but the stored value should be canonical and agree with API-created users.
    const email = (emailClaim ?? `${sub}@unknown`).trim().toLowerCase();

    // Name resolution: given_name + family_name → split `name` → email local-part.
    let firstName: string;
    let lastName: string;
    const givenName =
      typeof profile['given_name'] === 'string'
        ? profile['given_name']
        : undefined;
    const familyName =
      typeof profile['family_name'] === 'string'
        ? profile['family_name']
        : undefined;
    if (givenName || familyName) {
      firstName = givenName ?? '';
      lastName = familyName ?? '';
    } else {
      const fullName =
        typeof profile['name'] === 'string' ? profile['name'] : undefined;
      if (fullName) {
        const parts = fullName.trim().split(/\s+/);
        firstName = parts[0] ?? '';
        lastName = parts.slice(1).join(' ') || '';
      } else {
        // Last resort: use the email local-part as firstName, empty lastName.
        firstName = email.split('@')[0] ?? sub;
        lastName = '';
      }
    }

    // Harden the JIT row against the @lazyit/shared User contract (firstName/lastName are
    // .min(1).max(100); ADR-0040/0038). The resolution above can still yield an empty field — a
    // whitespace-only given_name, a single-token `name`, or the email-local-part path (no last
    // name) — which would persist a row the API/zod schema would reject, leaving the user broken in
    // the directory. Coerce both to a non-empty, trimmed, ≤100-char value, falling back to the
    // email local-part (then the sub) so the JIT row always satisfies the same constraints as an
    // API-created user. The IdP claims still take precedence whenever they are usable.
    const fallback = (email.split('@')[0] || sub).slice(0, 100);
    // Whether the names came from real OIDC claims (vs. the email-local-part last resort). Only
    // claim-derived names are trustworthy enough to overwrite a seed placeholder on the claim step.
    const namesFromClaims = Boolean(givenName || familyName || profile['name']);
    firstName = this.coerceName(firstName, fallback);
    lastName = this.coerceName(lastName, fallback);

    // Account linking by verified email (ADR-0038 addendum, trusted-IdP model). The externalId
    // lookup above missed, so this `sub` has never logged in. Before minting a fresh row, check
    // whether a LIVE user already holds this email — the common case being the seeded ADMIN
    // (admin@lazyit.local, externalId=null) that an operator now signs into via the IdP. This read
    // uses the NORMAL soft-delete-filtered client (no includeSoftDeleted), so a soft-deleted /
    // offboarded user with the same email is invisible here and is NEVER linked or resurrected.
    //
    // SECURITY: linking by email is sound ONLY because the IdP is trusted to own/verify the email
    // (ADR-0037/0038). We therefore (a) CLAIM a row only when its externalId IS NULL (an account no
    // identity has bound yet) and (b) NEVER re-bind a row already linked to a different `sub` —
    // re-binding would be account takeover. The claim is a race-safe `updateMany` guarded by
    // `{ id, externalId: null }`: a concurrent first-login wins the row exactly once; the loser's
    // updateMany matches 0 rows and it refetches the now-linked row, so the flow stays idempotent.
    const emailOwner = await this.prisma.user.findFirst({ where: { email } });
    if (emailOwner) {
      if (emailOwner.externalId === sub) {
        // Defensive: normally the externalId lookup already caught this; return the live row.
        return emailOwner;
      }
      if (emailOwner.externalId !== null) {
        // Already bound to a DIFFERENT identity — refuse rather than steal it.
        throw new ConflictException(
          'This email is already linked to a different identity',
        );
      }
      // externalId IS NULL → claim it for this sub. Preserve the existing role (this is how the
      // seeded ADMIN's role is inherited by the operator's IdP identity). Optionally refresh the
      // name only when the existing values look like a seed placeholder AND we have real claims.
      const data: Prisma.UserUpdateManyMutationInput = { externalId: sub };
      if (namesFromClaims && this.looksLikeSeedPlaceholder(emailOwner)) {
        data.firstName = firstName;
        data.lastName = lastName;
      }
      const claimed = await this.prisma.user.updateMany({
        where: { id: emailOwner.id, externalId: null },
        data,
      });
      // Refetch the canonical row: either we claimed it (count 1) or a concurrent login claimed it
      // first (count 0) and we read the now-linked row. The normal client only returns LIVE rows.
      const linked = await this.prisma.user.findFirst({
        where: { id: emailOwner.id },
      });
      if (linked) {
        if (claimed.count === 0 && linked.externalId !== sub) {
          // A concurrent login bound this email to a DIFFERENT sub between our read and write.
          throw new ConflictException(
            'This email is already linked to a different identity',
          );
        }
        return linked;
      }
      // Extremely unlikely (row soft-deleted between read and refetch) — fall through to create.
    }

    // Upsert on the externalId unique key (race-proof): if a parallel first-login request already
    // created the row, the `update: {}` no-op returns it instead of throwing P2002. `where` targets
    // only `externalId`, so the soft-deleted case is already handled above (we 403 before reaching
    // here) and an upsert can never silently revive a deleted row.
    return this.prisma.user.upsert({
      where: { externalId: sub },
      create: {
        externalId: sub,
        email,
        firstName,
        lastName,
        isActive: true,
        role,
      },
      update: {},
    });
  }

  /**
   * Coerce a JIT-resolved name field to a value that satisfies the @lazyit/shared User contract
   * (trimmed, non-empty, ≤100 chars). Trims the candidate; if it is empty after trimming, uses the
   * supplied non-empty fallback (the email local-part, then the sub). Both inputs are then capped at
   * 100 to match the schema's `.max(100)`. Keeps the JIT row consistent with an API-created user.
   */
  private coerceName(candidate: string, fallback: string): string {
    const trimmed = candidate.trim();
    return (trimmed.length > 0 ? trimmed : fallback).slice(0, 100);
  }

  /**
   * Heuristic for "this row's name is a seed/placeholder, not a real human-entered name", used only
   * when linking an unclaimed email row (ADR-0038 addendum) to decide whether the first OIDC login
   * may refresh the name from the IdP claims. Conservative on purpose: matches the seed's literal
   * `Admin User` (case-insensitive) so a real operator name is never silently overwritten. The role
   * is always preserved regardless — only the display name may be refreshed.
   */
  private looksLikeSeedPlaceholder(user: User): boolean {
    return (
      user.firstName.trim().toLowerCase() === 'admin' &&
      user.lastName.trim().toLowerCase() === 'user'
    );
  }

  /**
   * Fetch the OIDC userinfo profile for the given access token. Fail-soft: returns the parsed
   * claims object on success, or `null` on any failure (missing issuer, discovery error, non-2xx,
   * malformed JSON) after logging a warning. Login must never break because userinfo failed.
   *
   * The userinfo endpoint is located via OIDC Discovery (read once, then cached) rather than a
   * hardcoded path, keeping the guard IdP-agnostic (BYOI — ADR-0037). When OIDC_JWKS_URI is set
   * (the Docker split-DNS case), both the discovery and userinfo requests are rewritten to the
   * internal origin with X-Forwarded-* headers, exactly like the JWKS init above.
   */
  private async fetchUserinfo(
    accessToken: string,
  ): Promise<ProfileClaims | null> {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) {
      return null;
    }

    try {
      const endpoint = await this.resolveUserinfoEndpoint(issuer);
      if (!endpoint) {
        return null;
      }

      const requestUrl = this.toInternalOrigin(endpoint);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      };
      const forwarded = this.forwardedHeaders(issuer);
      if (forwarded) {
        Object.assign(headers, forwarded);
      }

      const res = await fetch(requestUrl, { headers });
      if (!res.ok) {
        this.logger.warn(
          `OIDC userinfo request returned ${res.status}; falling back to token claims for JIT provisioning`,
        );
        return null;
      }
      return (await res.json()) as ProfileClaims;
    } catch (err) {
      this.logger.warn(
        `OIDC userinfo enrichment failed (${err instanceof Error ? err.message : String(err)}); falling back to token claims for JIT provisioning`,
      );
      return null;
    }
  }

  /**
   * Resolve and cache the userinfo endpoint via OIDC Discovery
   * (`${issuer}/.well-known/openid-configuration`). Returns the discovered `userinfo_endpoint`
   * (its EXTERNAL URL as advertised by the IdP) or null if discovery fails / omits it. Cached at
   * instance scope so repeated provisions reuse the result. Throwing here is fine — the caller
   * (`fetchUserinfo`) wraps the whole flow in try/catch and treats it as fail-soft.
   */
  private async resolveUserinfoEndpoint(
    issuer: string,
  ): Promise<string | null> {
    if (this.userinfoEndpoint) {
      return this.userinfoEndpoint;
    }

    const discoveryUrl = this.toInternalOrigin(
      `${issuer}/.well-known/openid-configuration`,
    );
    const headers: Record<string, string> = { Accept: 'application/json' };
    const forwarded = this.forwardedHeaders(issuer);
    if (forwarded) {
      Object.assign(headers, forwarded);
    }

    const res = await fetch(discoveryUrl, { headers });
    if (!res.ok) {
      this.logger.warn(
        `OIDC discovery request returned ${res.status}; cannot resolve userinfo endpoint`,
      );
      return null;
    }
    const doc = (await res.json()) as { userinfo_endpoint?: unknown };
    if (typeof doc.userinfo_endpoint !== 'string') {
      this.logger.warn(
        'OIDC discovery document has no string userinfo_endpoint; skipping userinfo enrichment',
      );
      return null;
    }
    this.userinfoEndpoint = doc.userinfo_endpoint;
    return this.userinfoEndpoint;
  }

  // ---------- internal-origin / forwarded-header helpers --------------------

  /**
   * X-Forwarded-* headers derived from the EXTERNAL issuer, or undefined when no internal-origin
   * rewrite is in effect. When OIDC_JWKS_URI is set (the Docker split-DNS case), requests reach
   * the IdP at an internal URL but the IdP still resolves its instance from the forwarded host, so
   * we forward the canonical external host/proto. When OIDC_JWKS_URI is unset, returns undefined
   * (no rewrite, no forwarded headers). Shared by the JWKS init and the discovery/userinfo flow.
   */
  private forwardedHeaders(
    issuer: string,
  ): { 'X-Forwarded-Host': string; 'X-Forwarded-Proto': string } | undefined {
    if (!process.env.OIDC_JWKS_URI) {
      return undefined;
    }
    const ext = new URL(issuer);
    return {
      'X-Forwarded-Host': ext.host,
      'X-Forwarded-Proto': ext.protocol.replace(':', ''),
    };
  }

  /**
   * Rewrite an external IdP URL to the internal origin when OIDC_JWKS_URI is set (the internal
   * origin is derived from it). The path/query are preserved; only the origin (scheme + host +
   * port) changes. When OIDC_JWKS_URI is unset, the URL is returned unchanged.
   */
  private toInternalOrigin(externalUrl: string): string {
    const jwksUri = process.env.OIDC_JWKS_URI;
    if (!jwksUri) {
      return externalUrl;
    }
    const internalOrigin = new URL(jwksUri).origin;
    const url = new URL(externalUrl);
    return `${internalOrigin}${url.pathname}${url.search}`;
  }

  /** Visible for testing: reset the cached JWKS set + userinfo endpoint between tests. */
  resetJwks(): void {
    this.jwks = null;
    this.userinfoEndpoint = null;
  }
}
