import { readFileSync } from 'node:fs';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { Role } from '../../../generated/prisma/client';

/**
 * ZitadelManagementService — the thin HTTP client behind {@link ZitadelIdentityProvider} (ADR-0043
 * Phase 2). It owns the two concerns that are pure plumbing and worth isolating from the IdP adapter:
 *
 *  1. **Service-account authentication** — a Private-Key JWT (RS256, RFC 7523) signed with the
 *     machine-key the operator provisions (ADR-0043 decision #4), exchanged at `/oauth/v2/token`
 *     (grant `urn:ietf:params:oauth:grant-type:jwt-bearer`, scope
 *     `urn:zitadel:iam:org:project:id:zitadel:aud`) for a Management-API access token. The token is
 *     CACHED and refreshed shortly before it expires so steady-state write-back does not re-auth.
 *  2. **Management calls** — create / deactivate user on the **v2** user service; manage the user's
 *     project-role GRANT (authorization) on the **v1** Management API. Zitadel v2.68.0 has NO
 *     `/v2/users/{id}/grants` endpoint (it 404s — the original bug); user-grant CRUD lives under
 *     `/management/v1/users/...` (search/add/update/delete), reached at the same internal origin.
 *
 * SECURITY / boot posture (ADR-0043 §6): a missing or misconfigured Management credential MUST NEVER
 * block login. This service is constructed lazily by the IdP adapter and reads its config defensively;
 * `assertConfigured()` throws a clear "Zitadel management not configured" error from the *management*
 * methods only — it is never on the runtime authN path, and the constructor never throws, so boot
 * cannot fail because of it. The service-account key/secret is NEVER logged.
 *
 * Network shape mirrors {@link JwtAuthGuard}'s JWKS/userinfo handling: Zitadel is reached at its
 * INTERNAL origin (derived from `ZITADEL_MGMT_API_URL`, falling back to `OIDC_JWKS_URI`'s origin) and
 * the canonical external host/proto are forwarded via `X-Forwarded-Host` / `X-Forwarded-Proto`
 * (derived from `OIDC_ISSUER`) so Zitadel resolves the right instance (otherwise: 404 "Instance not
 * found"). The token `aud` is the EXTERNAL issuer (what Zitadel signs/expects), not the internal URL.
 */

/** Shape of a Zitadel machine-key JSON (downloaded from the console or provisioned by the sidecar). */
interface ZitadelServiceAccountKey {
  type?: string;
  keyId: string;
  /** PEM private key — Zitadel emits PKCS#1 (`BEGIN RSA PRIVATE KEY`); PKCS#8 is also accepted. */
  key: string;
  userId: string;
}

/** A cached Management-API access token plus the epoch-ms instant it should be refreshed at. */
interface CachedToken {
  accessToken: string;
  /** Refresh once `Date.now()` passes this (expiry minus a safety skew). */
  refreshAtMs: number;
}

/** Maps the lazyit {@link Role} enum to the Zitadel project role KEYS provisioned for the project. */
const ROLE_KEY: Record<Role, string> = {
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  VIEWER: 'VIEWER',
};

/** Refresh the cached token this many ms before its real expiry, to avoid a mid-flight 401. */
const TOKEN_REFRESH_SKEW_MS = 60_000;
/** Signed-assertion lifetime (Zitadel caps JWT-profile assertions at 1h). */
const ASSERTION_TTL_SECONDS = 600;

export class ZitadelManagementService {
  private readonly logger = new Logger(ZitadelManagementService.name);

  /** Parsed SA key (lazy). `null` once we have tried and found the config absent/invalid. */
  private serviceAccountKey: ZitadelServiceAccountKey | null = null;
  /** Imported signing key derived from the SA key PEM (lazy; handles PKCS#1 and PKCS#8). */
  private signingKey: KeyObject | null = null;
  /** Whether config resolution has run at least once (so we do not re-read the file each call). */
  private configResolved = false;
  /** The cached Management-API access token (null until first fetch / after a failure). */
  private cachedToken: CachedToken | null = null;

  /**
   * Visible for testing: the configured project id (the role grants target this project). Sourced
   * from `process.env.ZITADEL_MGMT_PROJECT_ID`, which the zero-touch boot loader back-fills from the
   * sidecar's oidc-client.json when the operator does not pin it (ADR-0043 Phase 3 — see
   * auth/bootstrap-file.ts). Env-set values are honoured unchanged (BYOI).
   */
  get projectId(): string | undefined {
    return process.env.ZITADEL_MGMT_PROJECT_ID?.trim() || undefined;
  }

  /**
   * Whether the Management config is present enough to attempt write-back. Read by the IdP adapter so
   * it can decide (in a future reconciliation path) without forcing a throw; the management methods
   * here still `assertConfigured()` so a half-configured deployment fails loudly rather than silently.
   *
   * Requires all three pieces write-back needs: the SA key (ZITADEL_MGMT_SA_KEY[_PATH]), the project
   * id (ZITADEL_MGMT_PROJECT_ID) and the external issuer (OIDC_ISSUER — the JWT `aud` + the
   * X-Forwarded-Host source). All three are resolvable either from explicit env or, in the bundled
   * zero-touch flow, from the sidecar files (sa-key.json + oidc-client.json) — see ADR-0043 Phase 3.
   */
  isConfigured(): boolean {
    this.resolveConfig();
    return (
      this.serviceAccountKey !== null &&
      this.projectId !== undefined &&
      !!process.env.OIDC_ISSUER?.trim()
    );
  }

  // ---------- Management calls ----------------------------------------------

  /** Create a human user; returns the new Zitadel user id. POST /v2/users/human. */
  async createUser(input: {
    email: string;
    firstName: string;
    lastName: string;
    role: Role;
  }): Promise<string> {
    this.assertConfigured();
    const body = {
      username: input.email,
      profile: { givenName: input.firstName, familyName: input.lastName },
      // Pre-verified: the operator's directory owns the mailbox (trusted-IdP model, ADR-0037/0038).
      email: { email: input.email, isVerified: true },
    };
    const res = await this.request('POST', '/v2/users/human', body);
    const userId = (res as { userId?: unknown }).userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw this.fail('createUser', 'response did not include a userId');
    }
    // Best-effort: mirror the initial role as a project-role grant. A grant failure must surface so the
    // caller can compensate (no split-brain) — it is awaited, not fire-and-forget.
    await this.grantRole(userId, input.role);
    return userId;
  }

  /** Deactivate (disable) a user. POST /v2/users/{userId}/deactivate. */
  async deactivateUser(externalId: string): Promise<void> {
    this.assertConfigured();
    await this.request(
      'POST',
      `/v2/users/${encodeURIComponent(externalId)}/deactivate`,
      {},
    );
  }

  /**
   * Set the user's lazyit role to exactly `role` on the configured project (single-role semantics).
   *
   * Zitadel v2.68.0 exposes user-grant (authorization) CRUD on the **v1** Management API — there is NO
   * `/v2/users/{id}/grants` (it 404s, the original bug). We therefore:
   *  1. SEARCH the user's existing grant on the lazyit project — POST /management/v1/users/grants/_search
   *     filtering by userId AND projectId (combined with AND).
   *  2. If NONE exists (the common case — a freshly-JIT'd user) → ADD a grant:
   *     POST /management/v1/users/{userId}/grants { projectId, roleKeys: [roleKey] }.
   *  3. If one EXISTS → UPDATE its roles to exactly the new role:
   *     PUT /management/v1/users/{userId}/grants/{grantId} { roleKeys: [roleKey] }.
   *
   * This set semantics avoids a delete+add race and handles the no-grant case gracefully (an empty
   * search is NOT an error).
   */
  async grantRole(externalId: string, role: Role): Promise<void> {
    this.assertConfigured();
    const roleKey = ROLE_KEY[role];
    if (!roleKey) {
      throw this.fail('grantRole', `no Zitadel role key mapped for "${role}"`);
    }
    const existing = await this.findProjectGrant(externalId);
    if (existing) {
      await this.request(
        'PUT',
        `/management/v1/users/${encodeURIComponent(externalId)}/grants/${encodeURIComponent(existing)}`,
        { roleKeys: [roleKey] },
      );
      return;
    }
    await this.request(
      'POST',
      `/management/v1/users/${encodeURIComponent(externalId)}/grants`,
      { projectId: this.projectId, roleKeys: [roleKey] },
    );
  }

  /**
   * Revoke the user's grant on the configured project, if any. Searches for it (userId + projectId)
   * and DELETEs it. DELETE /management/v1/users/{userId}/grants/{grantId}. No-op when none exists.
   */
  async revokeRole(externalId: string): Promise<void> {
    this.assertConfigured();
    const existing = await this.findProjectGrant(externalId);
    if (!existing) {
      return;
    }
    await this.request(
      'DELETE',
      `/management/v1/users/${encodeURIComponent(externalId)}/grants/${encodeURIComponent(existing)}`,
    );
  }

  /**
   * Mirror an admin profile edit (name and/or email) onto the EXISTING Zitadel user (issue #149). The
   * `externalId` is the Zitadel user id and never changes — this is an update, NOT a re-link.
   *
   * Two v2 user-service sub-resources, each issued only when its field actually changed:
   *  - PROFILE (givenName / familyName) → PUT /v2/users/human/{id} { profile: { givenName, familyName } }.
   *  - EMAIL → POST /v2/users/{id}/email { email, isVerified: true }. We set it PRE-VERIFIED (the same
   *    trusted-IdP stance as createUser, ADR-0037/0038): the operator's directory owns the mailbox, so
   *    the new address is trusted and Zitadel does NOT enter a re-verification flow that could disrupt
   *    login / the account link. Omitting `isVerified` would make Zitadel generate a verification code
   *    and (depending on config) email it — re-verification we deliberately avoid.
   *
   * Each call surfaces a non-2xx as a 503 (no silent partial write); the Users service runs this inside
   * its compensation so a failure reverts the local row (no split-brain, INV-5).
   */
  async updateUser(
    externalId: string,
    input: { firstName?: string; lastName?: string; email?: string },
  ): Promise<void> {
    this.assertConfigured();
    const id = encodeURIComponent(externalId);
    // Profile (name) — only when a name field is present.
    if (input.firstName !== undefined || input.lastName !== undefined) {
      const profile: { givenName?: string; familyName?: string } = {};
      if (input.firstName !== undefined) profile.givenName = input.firstName;
      if (input.lastName !== undefined) profile.familyName = input.lastName;
      await this.request('PUT', `/v2/users/human/${id}`, { profile });
    }
    // Email — pre-verified so the change never forces re-verification (INV-2 / account link intact).
    if (input.email !== undefined) {
      await this.request('POST', `/v2/users/${id}/email`, {
        email: input.email,
        isVerified: true,
      });
    }
  }

  /**
   * Trigger Zitadel's password-reset notification for the user (issue #149). lazyit never sets or sends
   * a password (ADR-0016/0037): this asks Zitadel to email the reset link via ZITADEL's own SMTP.
   *
   * POST /v2/users/{id}/password_reset { sendLink: {} } — `sendLink` makes Zitadel deliver the reset
   * link by email (vs `returnCode`, which would hand the raw code back to lazyit; we explicitly do NOT
   * want lazyit to handle the credential). Delivery requires Zitadel's SMTP to be configured — if it is
   * not, the notification is queued/dropped by Zitadel, not by lazyit. A non-2xx surfaces as a 503.
   */
  async requestPasswordReset(externalId: string): Promise<void> {
    this.assertConfigured();
    await this.request(
      'POST',
      `/v2/users/${encodeURIComponent(externalId)}/password_reset`,
      { sendLink: {} },
    );
  }

  /**
   * Find the user's single grant id on the configured project, or `undefined` if they have none.
   * POST /management/v1/users/grants/_search with a userIdQuery + projectIdQuery (combined with AND).
   * An empty result is the COMMON case (a freshly-JIT'd user) and is NOT an error.
   */
  private async findProjectGrant(
    externalId: string,
  ): Promise<string | undefined> {
    const projectId = this.projectId;
    const listed = await this.request(
      'POST',
      '/management/v1/users/grants/_search',
      {
        queries: [
          { userIdQuery: { userId: externalId } },
          { projectIdQuery: { projectId } },
        ],
      },
    );
    const grants = this.extractGrants(listed);
    // The search already filters by projectId; double-check defensively before returning the id.
    const match = grants.find((g) => g.projectId === projectId && g.id) ?? grants.find((g) => g.id);
    return match?.id;
  }

  // ---------- token cache + HTTP --------------------------------------------

  /**
   * The Management-API access token, fetched (and cached) on demand. Reuses the cached token until it
   * is within {@link TOKEN_REFRESH_SKEW_MS} of expiry, then re-authenticates with a fresh signed
   * assertion. Visible for testing (the IdP adapter does not call it directly).
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.refreshAtMs) {
      return this.cachedToken.accessToken;
    }
    const assertion = await this.buildAssertion();
    const tokenUrl = `${this.internalOrigin()}/oauth/v2/token`;
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      scope: 'openid urn:zitadel:iam:org:project:id:zitadel:aud',
      assertion,
    });

    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...this.forwardedHeaders(),
        },
        body: form.toString(),
      });
    } catch (err) {
      throw this.fail(
        'getAccessToken',
        `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      // Never log the response body (it can echo the assertion); status only.
      throw this.fail(
        'getAccessToken',
        `token endpoint returned ${res.status}`,
      );
    }
    const json = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof json.access_token !== 'string') {
      throw this.fail('getAccessToken', 'token response missing access_token');
    }
    const expiresInSec =
      typeof json.expires_in === 'number' && json.expires_in > 0
        ? json.expires_in
        : 3600;
    this.cachedToken = {
      accessToken: json.access_token,
      refreshAtMs: Date.now() + expiresInSec * 1000 - TOKEN_REFRESH_SKEW_MS,
    };
    return this.cachedToken.accessToken;
  }

  /** Build + sign the RFC-7523 JWT-profile assertion (RS256, kid=keyId, iss=sub=userId, aud=issuer). */
  private async buildAssertion(): Promise<string> {
    this.assertConfigured();
    const key = this.serviceAccountKey!;
    const signingKey = this.getSigningKey();
    const issuer = this.externalIssuer();
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: key.keyId })
      .setIssuer(key.userId)
      .setSubject(key.userId)
      .setAudience(issuer)
      .setIssuedAt()
      .setExpirationTime(`${ASSERTION_TTL_SECONDS}s`)
      .sign(signingKey);
  }

  /**
   * Perform a Management-API request with the cached access token; returns the parsed JSON (or `{}`
   * for an empty body). Maps any non-2xx / transport error to the structured failure the IdP adapter
   * re-throws as 503 — never a silent partial write (ADR-0043 §3/§6).
   */
  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const url = `${this.internalOrigin()}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...this.forwardedHeaders(),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw this.fail(
        `${method} ${path}`,
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw this.fail(
        `${method} ${path}`,
        `Management API returned ${res.status}`,
      );
    }
    const text = await res.text();
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }

  /**
   * Pull the grant list out of a v1 user-grant search response (`result` array), defensively typed.
   * Each `UserGrant` carries its grant id as `id` (proto field 1); we also accept the legacy
   * `userGrantId`/`grantId` aliases for resilience.
   */
  private extractGrants(
    listed: unknown,
  ): { id?: string; projectId?: string }[] {
    const container = (listed ?? {}) as {
      result?: unknown;
      grants?: unknown;
    };
    const raw = Array.isArray(container.result)
      ? container.result
      : Array.isArray(container.grants)
        ? container.grants
        : [];
    return raw.map((g) => {
      const grant = (g ?? {}) as Record<string, unknown>;
      const id =
        typeof grant.id === 'string'
          ? grant.id
          : typeof grant.userGrantId === 'string'
            ? grant.userGrantId
            : typeof grant.grantId === 'string'
              ? grant.grantId
              : undefined;
      const projectId =
        typeof grant.projectId === 'string' ? grant.projectId : undefined;
      return { id, projectId };
    });
  }

  // ---------- config / origin helpers ---------------------------------------

  /**
   * Read + parse the SA key from `ZITADEL_MGMT_SA_KEY` (inline JSON) or `ZITADEL_MGMT_SA_KEY_PATH`
   * (a mounted secret file). Runs at most once; on any problem it logs a structured WARN (never the
   * key itself) and leaves `serviceAccountKey` null so the management methods throw a clear error
   * WITHOUT ever blocking boot/login.
   */
  private resolveConfig(): void {
    if (this.configResolved) {
      return;
    }
    this.configResolved = true;

    const inline = process.env.ZITADEL_MGMT_SA_KEY?.trim();
    const path = process.env.ZITADEL_MGMT_SA_KEY_PATH?.trim();
    let rawJson: string | undefined;
    if (inline) {
      rawJson = inline;
    } else if (path) {
      try {
        rawJson = readFileSync(path, 'utf8');
      } catch (err) {
        this.logger.warn(
          `Zitadel management: could not read ZITADEL_MGMT_SA_KEY_PATH (${err instanceof Error ? err.message : String(err)}); write-back disabled (login unaffected)`,
        );
        return;
      }
    } else {
      this.logger.warn(
        'Zitadel management: no service-account key configured (set ZITADEL_MGMT_SA_KEY or ZITADEL_MGMT_SA_KEY_PATH); write-back disabled (login unaffected)',
      );
      return;
    }

    let parsed: ZitadelServiceAccountKey;
    try {
      parsed = JSON.parse(rawJson) as ZitadelServiceAccountKey;
    } catch {
      this.logger.warn(
        'Zitadel management: service-account key is not valid JSON; write-back disabled (login unaffected)',
      );
      return;
    }
    if (!parsed.key || !parsed.keyId || !parsed.userId) {
      this.logger.warn(
        'Zitadel management: service-account key JSON is missing key/keyId/userId; write-back disabled (login unaffected)',
      );
      return;
    }
    if (!this.projectId) {
      this.logger.warn(
        'Zitadel management: ZITADEL_MGMT_PROJECT_ID is not set; write-back disabled (login unaffected)',
      );
      // Keep the parsed key so isConfigured() reports the precise gap, but management methods still throw.
    }
    this.serviceAccountKey = parsed;
  }

  /** Import the SA key PEM into a signing KeyObject (handles PKCS#1 and PKCS#8); cached. */
  private getSigningKey(): KeyObject {
    if (this.signingKey) {
      return this.signingKey;
    }
    const key = this.serviceAccountKey;
    if (!key) {
      throw this.fail('getSigningKey', 'service-account key not resolved');
    }
    try {
      // node:crypto accepts both PKCS#1 (BEGIN RSA PRIVATE KEY) and PKCS#8 (BEGIN PRIVATE KEY); jose's
      // SignJWT.sign accepts the resulting KeyObject directly. Zitadel emits PKCS#1.
      this.signingKey = createPrivateKey(key.key);
    } catch (err) {
      throw this.fail(
        'getSigningKey',
        `could not import service-account private key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.signingKey;
  }

  /** The internal origin to reach Zitadel at: ZITADEL_MGMT_API_URL, else OIDC_JWKS_URI's origin. */
  private internalOrigin(): string {
    const explicit = process.env.ZITADEL_MGMT_API_URL?.trim();
    if (explicit) {
      return new URL(explicit).origin;
    }
    const jwksUri = process.env.OIDC_JWKS_URI?.trim();
    if (jwksUri) {
      return new URL(jwksUri).origin;
    }
    // Last resort: the external issuer (single-host deployments where internal == external).
    return new URL(this.externalIssuer()).origin;
  }

  /** The external issuer URL — the JWT `aud` and the canonical host Zitadel resolves its instance by. */
  private externalIssuer(): string {
    const issuer = process.env.OIDC_ISSUER?.trim();
    if (!issuer) {
      throw this.fail('config', 'OIDC_ISSUER is not configured');
    }
    return issuer;
  }

  /**
   * X-Forwarded-* derived from the external issuer, so Zitadel (reached at the internal origin) still
   * resolves the right instance. Mirrors JwtAuthGuard.forwardedHeaders: only emitted when the internal
   * origin actually differs from the external issuer's origin (otherwise no rewrite is in effect).
   */
  private forwardedHeaders(): Record<string, string> {
    const issuer = process.env.OIDC_ISSUER?.trim();
    if (!issuer) {
      return {};
    }
    const ext = new URL(issuer);
    if (ext.origin === this.internalOrigin()) {
      return {};
    }
    return {
      'X-Forwarded-Host': ext.host,
      'X-Forwarded-Proto': ext.protocol.replace(':', ''),
    };
  }

  // ---------- failure / guards ----------------------------------------------

  /**
   * Throw the canonical "not configured" error from a management method when the SA key / project id
   * is absent or invalid. Never blocks boot/login (only called from management methods, never the
   * authN path). The IdP adapter maps this to a 503 upstream.
   */
  private assertConfigured(): void {
    this.resolveConfig();
    if (!this.serviceAccountKey || !this.projectId) {
      throw this.fail(
        'assertConfigured',
        'Zitadel management not configured',
        false,
      );
    }
  }

  /**
   * Build the structured failure thrown by every Management path. Logs a WARN (operation + reason,
   * never the credential) and returns a {@link ServiceUnavailableException} so the upstream Users flow
   * surfaces 503 (ADR-0043 §3/§6) instead of a silent partial write. `logIt=false` suppresses the warn
   * for the deliberate not-configured case (already warned once at resolveConfig time).
   */
  private fail(
    operation: string,
    reason: string,
    logIt = true,
  ): ServiceUnavailableException {
    if (logIt) {
      this.logger.warn(`Zitadel management ${operation} failed: ${reason}`);
    }
    return new ServiceUnavailableException(
      operation === 'assertConfigured'
        ? 'Zitadel management not configured'
        : `Zitadel management call failed (${operation})`,
    );
  }

  /** Visible for testing: clear the token + key caches so a test can re-exercise the auth path. */
  resetCache(): void {
    this.cachedToken = null;
    this.serviceAccountKey = null;
    this.signingKey = null;
    this.configResolved = false;
  }
}
