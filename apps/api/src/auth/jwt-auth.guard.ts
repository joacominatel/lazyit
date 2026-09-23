import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
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
  hasDelegatedIdentity,
  readDelegatedIdentity,
} from './delegated-identity';
import {
  PrincipalLoaderService,
  type PrincipalLoadFailure,
} from './principal-loader.service';
import { ServiceAccountAuthenticator } from './service-account-authenticator';
import {
  LocalCredentialService,
  type LocalSessionContext,
  type SessionClaims,
} from './local/local-credential.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 401 messages `handleLocal` has always answered with, per shared re-load refusal. */
const LOCAL_REFUSAL_MESSAGES: Record<PrincipalLoadFailure, string> = {
  not_found: 'Account not found',
  session_revoked: 'Session has been revoked',
  inactive: 'Account disabled',
  directory_only: 'Account cannot log in',
  revoked: 'Account not found',
  expired: 'Account not found',
};

/** The subset of OIDC userinfo / standard claims used for JIT provisioning. */
interface ProfileClaims {
  email?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  [key: string]: unknown;
}

/**
 * Global auth guard (ADR-0038, extended for service accounts by ADR-0048 and for AI delegation by
 * ADR-0097).
 *
 * DELEGATED-IDENTITY branch (ADR-0097, R1) — runs FIRST, in every mode, and ONLY for an in-process AI
 *   tool call: the AI tool dispatcher builds a synthetic request carrying a module-private symbol
 *   (`delegated-identity.ts`) naming the invoking principal. The principal is RE-LOADED from the DB with
 *   the same {@link PrincipalLoaderService} the network branches use, so a tool call is refused exactly
 *   when that principal's own request would be: a soft-deleted, inactive or directory-only user, a
 *   `sessionEpoch` mismatch, a revoked, inactive or expired service account — all a generic 401. A network
 *   request cannot carry a symbol-keyed property, so this branch is unreachable over HTTP.
 *
 * SERVICE-ACCOUNT branch (ADR-0048) — runs next, in every mode: a `Bearer lzit_sa_<id>_<secret>`
 *   token authenticates a NON-HUMAN principal through the {@link ServiceAccountAuthenticator} (shared
 *   with `/mcp`, R10): the id is looked up in the DB (including soft-deleted rows so a revoked account is
 *   detected), the secret is constant-time-compared to the stored SHA-256 `tokenHash`, and a revoked /
 *   inactive / expired account is rejected — all as a generic 401. On success it sets
 *   `request.serviceAccount` + `request.principal = {kind:'service', …}` (with the direct grants resolved
 *   DB-first) and leaves `request.user` undefined (a service account is never a human). Any other bearer
 *   (or none) falls through to the unchanged human auth below.
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

  private readonly principals: PrincipalLoaderService;
  private readonly serviceAccounts: ServiceAccountAuthenticator;

  // The two collaborators are provided by AuthModule. They are @Optional with an equivalent default so a
  // guard built by hand from the three original dependencies (the existing auth specs) behaves the same.
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly localCredentials: LocalCredentialService,
    @Optional() principals?: PrincipalLoaderService,
    @Optional() serviceAccounts?: ServiceAccountAuthenticator,
  ) {
    this.principals = principals ?? new PrincipalLoaderService(prisma);
    this.serviceAccounts =
      serviceAccounts ??
      new ServiceAccountAuthenticator(prisma, this.principals);
  }

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

    // DELEGATED-IDENTITY branch (ADR-0097, R1) — an in-process AI tool call. Checked before anything that
    // reads headers: the synthetic request's identity is the symbol, never a bearer. Unreachable from
    // HTTP (a network request cannot own a symbol-keyed property).
    if (hasDelegatedIdentity(request)) {
      return this.handleDelegated(request);
    }

    // SERVICE-ACCOUNT branch (ADR-0048) — runs BEFORE the human modes. A lazyit-native token
    // (`Authorization: Bearer lzit_sa_...`) authenticates a non-human principal in EVERY mode (it has
    // no IdP dependency, BYOI-safe), so it is checked first. Any other bearer (or none) falls through
    // to the unchanged human auth (shim or OIDC). The SA branch sets request.principal itself.
    const bearer = this.extractBearer(request);
    if (bearer && this.serviceAccounts.isServiceAccountToken(bearer)) {
      return this.handleServiceAccount(request, bearer);
    }

    // Dispatch by mode (ADR-0086 §3): the `shim ? … : oidc` ternary became a switch when `local` was
    // added. Order is unchanged — SA-token branch already ran first above; `default` is `oidc` (the only
    // remaining valid value, since boot-config rejects anything but shim|local|oidc). A local (HS256)
    // token therefore reaches handleOidc in oidc mode and is rejected (RS256 pin), and an OIDC (RS256)
    // token reaches handleLocal in local mode and is rejected (HS256 pin) — cross-mode rejection.
    let result: boolean;
    switch (process.env.AUTH_MODE) {
      case 'shim':
        result = await this.handleShim(request);
        break;
      case 'local':
        result = await this.handleLocal(request);
        break;
      default:
        result = await this.handleOidc(request);
        break;
    }

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

  // ---------- delegated identity (ADR-0097, R1) ----------------------------

  /**
   * Authenticate an in-process AI tool call from its delegated identity. DB-FIRST (INV-1) and through the
   * SAME {@link PrincipalLoaderService} as `handleLocal` and the service-account branch, so the refusals
   * are identical: a human is re-loaded live and refused on a `sessionEpoch` mismatch, when inactive or
   * when directory-only; a service account is refused when revoked, inactive or expired, and its grants
   * are re-resolved. A malformed identity is refused (fail closed). Every refusal is a generic 401 — the
   * AI layer maps it to a tool error; it never reaches a network client.
   *
   * Sets exactly what the network branches set: `request.user` + a human principal, or
   * `request.serviceAccount` + a service principal with `request.user` undefined. The guards that follow
   * (MustChangePasswordGuard, RolesGuard, handler guards) then run unchanged.
   */
  private async handleDelegated(
    request: Request & {
      user?: User;
      serviceAccount?: ServiceAccount;
      principal?: Principal;
    },
  ): Promise<boolean> {
    const invalid = () =>
      new UnauthorizedException('Delegated principal is no longer valid');

    const identity = readDelegatedIdentity(request);
    if (!identity) {
      throw invalid();
    }

    if (identity.kind === 'human') {
      const loaded = await this.principals.loadHuman(
        identity.userId,
        identity.sessionEpoch,
      );
      if (!loaded.ok) {
        throw invalid();
      }
      request.user = loaded.principal.user;
      request.serviceAccount = undefined;
      request.principal = loaded.principal;
      return true;
    }

    const loaded = await this.principals.loadServiceAccount(
      identity.serviceAccountId,
    );
    if (!loaded.ok) {
      throw invalid();
    }
    request.serviceAccount = loaded.principal.serviceAccount;
    request.principal = loaded.principal;
    request.user = undefined;
    return true;
  }

  // ---------- service-account mode (ADR-0048) -------------------------------

  /**
   * Authenticate a service account from a lazyit-native token (ADR-0048) through the shared
   * {@link ServiceAccountAuthenticator} (DB-first; every refusal a generic 401), then set
   * `request.principal` (kind:'service') + `request.serviceAccount`. `request.user` stays undefined — a
   * service account is NEVER a human (it never enters the user directory, JIT or last-admin logic).
   */
  private async handleServiceAccount(
    request: Request & {
      user?: User;
      serviceAccount?: ServiceAccount;
      principal?: Principal;
    },
    bearer: string,
  ): Promise<boolean> {
    const principal = await this.serviceAccounts.authenticate(bearer);
    request.serviceAccount = principal.serviceAccount;
    request.principal = principal;
    request.user = undefined;
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

  // ---------- local mode (ADR-0086) -----------------------------------------

  /**
   * Authenticate a HUMAN from a first-party local session token (ADR-0086 §3). DB-FIRST (INV-1), mirroring
   * handleOidc but with a stateless-JWT revocation via `sessionEpoch`:
   *   1. Require a Bearer token; verify it with the LocalCredentialService — HS256 PINNED (rejects
   *      `alg:none` / an RS256-forged token) + `exp` enforced. A bad/expired token → generic 401. A
   *      "keep me signed in" token (signed remember-me marker, ADR-0086 §8) has no `exp`, so steps 2–3
   *      are the ONLY things that end it.
   *   2. Re-load the User by `sub` on the LIVE-filtered client EVERY request (a soft-deleted row is
   *      invisible here → 401), so offboarding/deletion takes effect immediately.
   *   3. Reject (401) when: the token's `epoch` ≠ the row's `sessionEpoch` (REVOCATION — logout /
   *      password-change / deactivate bump the epoch, killing all prior tokens), the account is inactive,
   *      or it is `directoryOnly` (a login-incapable directory person must never authenticate).
   *
   * A local token is only accepted in local mode; in oidc mode it falls to handleOidc and is rejected
   * (cross-mode rejection, asserted in tests). Sets request.user and `request.localSession` (whether the
   * session is remember-me, for a route that re-mints the token); the principal mirror happens in canActivate.
   */
  private async handleLocal(
    request: Request & { user?: User; localSession?: LocalSessionContext },
  ): Promise<boolean> {
    const bearer = this.extractBearer(request);
    if (!bearer) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    let claims: SessionClaims;
    try {
      claims = await this.localCredentials.verifySession(bearer);
    } catch {
      throw new UnauthorizedException('Invalid or expired session token');
    }

    // A token we minted always carries a uuid sub; guard against a malformed sub reaching the uuid column
    // (a would-be 500) — treat as invalid. Defense-in-depth: forging a sub requires the signing secret.
    if (!UUID_REGEX.test(claims.sub)) {
      throw new UnauthorizedException('Invalid session token');
    }

    // The shared DB-first re-load (also the delegated branch's): a LIVE-filtered read (an offboarded user
    // is invisible → 401), then revocation (any epoch bump — logout / password change / deactivate /
    // offboard — invalidates old tokens), then inactive, then directory-only (no login capability).
    const loaded = await this.principals.loadHuman(claims.sub, claims.epoch);
    if (!loaded.ok) {
      throw new UnauthorizedException(LOCAL_REFUSAL_MESSAGES[loaded.reason]);
    }

    request.user = loaded.principal.user;
    request.localSession = { rememberMe: claims.rememberMe };
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
    // ADR-0069 REDESIGN §3.6 / §7: EXCLUDE directory-only persons from the bootstrap count. A bulk
    // import can mint hundreds of `directoryOnly` rows (no login, role VIEWER); without this filter the
    // FIRST real OIDC login would see a non-empty table and fall to VIEWER, leaving the instance with no
    // ADMIN. A directory person is never administrative and never logs in, so excluding it is correct.
    // `includeSoftDeleted: true` is KEPT (an offboarded real user still counts — no silent ADMIN reset).
    const userCount = await this.prisma.user.count({
      where: { directoryOnly: false },
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

    // SEC-020: derive whether the IdP has verified this email (OIDC Core §5.7, ADR-0038).
    // Some IdPs emit the boolean true; others emit the string "true". Only those two values are
    // treated as verified — anything else (false, "false", absent) is unverified.
    const emailVerified =
      profile['email_verified'] === true ||
      profile['email_verified'] === 'true';

    // Account linking by verified email (ADR-0038 addendum, trusted-IdP model). The externalId
    // lookup above missed, so this `sub` has never logged in. Before minting a fresh row, check
    // whether a LIVE user already holds this email — the common case being the seeded ADMIN
    // (admin@lazyit.local, externalId=null) that an operator now signs into via the IdP. This read
    // uses the NORMAL soft-delete-filtered client (no includeSoftDeleted), so a soft-deleted /
    // offboarded user with the same email is invisible here and is NEVER linked or resurrected.
    //
    // SECURITY: linking by email is sound ONLY because the IdP is trusted to own/verify the email
    // (ADR-0037/0038). We therefore (a) CLAIM a row only when its externalId IS NULL (an account no
    // identity has bound yet), (b) NEVER re-bind a row already linked to a different `sub` —
    // re-binding would be account takeover — and (c) NEVER claim an existing row on an UNVERIFIED
    // email (SEC-020: emailVerified must be true, or we refuse with 403 rather than silently
    // inheriting the existing row's role). The claim is a race-safe `updateMany` guarded by
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
      // SEC-020: linking by email is only sound when the IdP VERIFIED the email (OIDC Core §5.7,
      // ADR-0038). Never inherit an existing row's role on an unverified email — refuse the link.
      if (!emailVerified) {
        throw new ForbiddenException(
          'Your identity provider has not verified this email address, so it cannot be linked to an existing account.',
        );
      }
      // externalId IS NULL → claim it for this sub. Preserve the existing role (this is how the
      // seeded ADMIN's role is inherited by the operator's IdP identity). Optionally refresh the
      // name only when the existing values look like a seed placeholder AND we have real claims.
      // ADR-0069 REDESIGN §3.5: PROMOTE a directory-only person on first login — set directoryOnly=false
      // so the linked row becomes a normal account (verified email is the only linking key, INV-2). A
      // no-op for a row that was already a real account (directoryOnly was already false).
      const data: Prisma.UserUpdateManyMutationInput = {
        externalId: sub,
        directoryOnly: false,
      };
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
