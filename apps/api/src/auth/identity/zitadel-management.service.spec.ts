import { generateKeyPairSync } from 'node:crypto';
import { Logger, ServiceUnavailableException } from '@nestjs/common';

// jose ships ESM that ts-jest cannot parse, and these tests do not assert the signature itself — only
// that an assertion is produced and posted. Mock SignJWT with a chainable builder that yields a fixed
// token. The real PEM import (node:crypto) is exercised by the service unchanged.
jest.mock('jose', () => {
  class SignJWT {
    setProtectedHeader() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setSubject() {
      return this;
    }
    setAudience() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    sign() {
      return Promise.resolve('signed.jwt.assertion');
    }
  }
  return { SignJWT };
});

// The service imports the generated Prisma client only for the `Role` TYPE (erased at compile time);
// stub it so jest does not load the real client (no DB needed for these pure unit tests).
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { ZitadelManagementService } from './zitadel-management.service';

/**
 * ZitadelManagementService unit tests (ADR-0043 Phase 2). The HTTP layer (`fetch`) is mocked — there
 * is NO live Zitadel, so these prove the call SHAPE (method/path/body), not the live endpoint: the
 * real Zitadel v2.68.0 endpoint correctness can only be confirmed by a `--profile prod` retest. We
 * assert: the service-account token is fetched once and reused (cache), create/deactivate hit the v2
 * user service, the user-grant set-role flow hits the v1 Management API (search → ADD when none / PUT
 * when one exists; an empty search is NOT an error), a non-2xx maps to a 503
 * ServiceUnavailableException, and an absent credential WARNs + throws "not configured" without ever
 * blocking.
 */
describe('ZitadelManagementService (ADR-0043 Phase 2)', () => {
  // A real RSA key so the JWT-profile assertion actually signs (PKCS#1 PEM, as Zitadel emits).
  let saKeyJson: string;
  const savedEnv = { ...process.env };
  let fetchMock: jest.Mock;

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    saKeyJson = JSON.stringify({
      type: 'serviceaccount',
      keyId: 'key-123',
      key: pem,
      userId: 'machine-user-1',
    });
  });

  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.ZITADEL_MGMT_SA_KEY;
    delete process.env.ZITADEL_MGMT_SA_KEY_PATH;
    delete process.env.ZITADEL_MGMT_PROJECT_ID;
    delete process.env.ZITADEL_MGMT_API_URL;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_JWKS_URI;

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  /** Configure a fully-wired Management service (key + project + internal origin + external issuer). */
  function configure(): ZitadelManagementService {
    process.env.ZITADEL_MGMT_SA_KEY = saKeyJson;
    process.env.ZITADEL_MGMT_PROJECT_ID = 'project-1';
    process.env.ZITADEL_MGMT_API_URL = 'http://zitadel:8080';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    return new ZitadelManagementService();
  }

  /** A successful token-endpoint Response. */
  function tokenResponse(accessToken = 'mgmt-token-1', expiresIn = 3600) {
    return {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ access_token: accessToken, expires_in: expiresIn }),
      text: () =>
        Promise.resolve(JSON.stringify({ access_token: accessToken })),
    };
  }

  /**
   * A JSON Response for a v2 call. `retryAfter` (seconds) seeds a `Retry-After` header so the retry
   * path (issue #196) can be exercised; the `headers` shape mimics the WHATWG `Headers.get` the
   * service reads. A real `fetch` Response always exposes `headers`, so the mock carries one too.
   */
  function jsonResponse(body: unknown, status = 200, retryAfter?: number) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' && retryAfter !== undefined
            ? String(retryAfter)
            : null,
      },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  }

  /** A captured fetch call: [url, init]. The service always sends a string body + string url. */
  type FetchCall = [string, RequestInit];

  /** The N-th captured fetch call, typed. */
  function callAt(n: number): FetchCall {
    return fetchMock.mock.calls[n] as FetchCall;
  }

  /** The request body of a captured fetch call, as a string (the service always sends string bodies). */
  function bodyOf(call: FetchCall): string {
    return call[1].body as string;
  }

  it('fetches a service-account token once and reuses it across calls (cache)', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // token exchange
      .mockResolvedValueOnce(jsonResponse({})) // deactivate #1
      .mockResolvedValueOnce(jsonResponse({})); // deactivate #2 (reuses the cached token)

    await svc.deactivateUser('ext-1');
    await svc.deactivateUser('ext-2');

    // 1 token call + 2 management calls = 3 total; the token endpoint was hit exactly once.
    const tokenCalls = (fetchMock.mock.calls as FetchCall[]).filter((c) =>
      c[0].includes('/oauth/v2/token'),
    );
    expect(tokenCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('exchanges a JWT-bearer assertion at /oauth/v2/token with the IAM scope', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({}));

    await svc.deactivateUser('ext-1');

    const call = callAt(0);
    expect(call[0]).toBe('http://zitadel:8080/oauth/v2/token');
    expect(call[1].method).toBe('POST');
    const body = bodyOf(call);
    expect(body).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );
    expect(body).toContain(
      'urn%3Azitadel%3Aiam%3Aorg%3Aproject%3Aid%3Azitadel%3Aaud',
    );
    expect(body).toContain('assertion=');
    // X-Forwarded-* derived from the external issuer (internal origin differs from it).
    const headers = call[1].headers as Record<string, string>;
    expect(headers['X-Forwarded-Host']).toBe('auth.example.com');
    expect(headers['X-Forwarded-Proto']).toBe('https');
  });

  it('createUser POSTs /v2/users/human, then grants the role, returning the new userId', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // token
      .mockResolvedValueOnce(jsonResponse({ userId: 'zitadel-user-7' })) // create
      .mockResolvedValueOnce(jsonResponse({ result: [] })) // grantRole → search (no existing grant)
      .mockResolvedValueOnce(jsonResponse({ userGrantId: 'g-1' })); // grantRole → ADD grant

    const id = await svc.createUser({
      email: 'a@b.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'MEMBER',
    });

    expect(id).toBe('zitadel-user-7');
    const createCall = callAt(1);
    expect(createCall[0]).toBe('http://zitadel:8080/v2/users/human');
    expect(createCall[1].method).toBe('POST');
    const createBody = JSON.parse(bodyOf(createCall)) as {
      username: string;
      profile: { givenName: string; familyName: string };
      email: { email: string; isVerified: boolean };
    };
    expect(createBody.username).toBe('a@b.com');
    expect(createBody.profile).toEqual({
      givenName: 'Ada',
      familyName: 'Lovelace',
    });
    expect(createBody.email).toEqual({ email: 'a@b.com', isVerified: true });

    // The grant search hits the v1 Management API filtering by userId AND projectId.
    const searchCall = callAt(2);
    expect(searchCall[0]).toBe(
      'http://zitadel:8080/management/v1/users/grants/_search',
    );
    expect(searchCall[1].method).toBe('POST');
    expect(JSON.parse(bodyOf(searchCall))).toEqual({
      queries: [
        { userIdQuery: { userId: 'zitadel-user-7' } },
        { projectIdQuery: { projectId: 'project-1' } },
      ],
    });

    // With no existing grant, the role is ADDed on the v1 Management API with the mapped MEMBER key.
    const grantCall = callAt(3);
    expect(grantCall[0]).toBe(
      'http://zitadel:8080/management/v1/users/zitadel-user-7/grants',
    );
    expect(grantCall[1].method).toBe('POST');
    const grantBody = JSON.parse(bodyOf(grantCall)) as {
      projectId: string;
      roleKeys: string[];
    };
    expect(grantBody).toEqual({ projectId: 'project-1', roleKeys: ['MEMBER'] });
  });

  it('deactivateUser POSTs /v2/users/{id}/deactivate', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({}));

    await svc.deactivateUser('zitadel-user-9');

    const call = callAt(1);
    expect(call[0]).toBe(
      'http://zitadel:8080/v2/users/zitadel-user-9/deactivate',
    );
    expect(call[1].method).toBe('POST');
  });

  it('grantRole ADDs a grant when the user has NO existing grant (no 404, no delete)', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // token
      .mockResolvedValueOnce(jsonResponse({ result: [] })) // search → empty (freshly-JIT'd user)
      .mockResolvedValueOnce(jsonResponse({ userGrantId: 'new-grant' })); // ADD grant

    await svc.grantRole('zitadel-user-9', 'ADMIN');

    // The search filters by userId AND projectId on the v1 Management API.
    const searchCall = callAt(1);
    expect(searchCall[1].method).toBe('POST');
    expect(searchCall[0]).toBe(
      'http://zitadel:8080/management/v1/users/grants/_search',
    );
    expect(JSON.parse(bodyOf(searchCall))).toEqual({
      queries: [
        { userIdQuery: { userId: 'zitadel-user-9' } },
        { projectIdQuery: { projectId: 'project-1' } },
      ],
    });

    // No existing grant → POST (ADD), never a PUT or DELETE; this is the path that used to 404.
    const addCall = callAt(2);
    expect(addCall[1].method).toBe('POST');
    expect(addCall[0]).toBe(
      'http://zitadel:8080/management/v1/users/zitadel-user-9/grants',
    );
    expect(JSON.parse(bodyOf(addCall))).toEqual({
      projectId: 'project-1',
      roleKeys: ['ADMIN'],
    });
    const methods = (fetchMock.mock.calls as FetchCall[]).map((c) => c[1].method);
    expect(methods).not.toContain('DELETE');
    expect(methods).not.toContain('PUT');
  });

  it('grantRole UPDATEs (PUT) the existing grant when the user already holds one', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // token
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ id: 'existing-grant', projectId: 'project-1' }],
        }),
      ) // search → one existing grant on the project
      .mockResolvedValueOnce(jsonResponse({})); // PUT update roles

    await svc.grantRole('zitadel-user-9', 'ADMIN');

    const updateCall = callAt(2);
    expect(updateCall[1].method).toBe('PUT');
    expect(updateCall[0]).toBe(
      'http://zitadel:8080/management/v1/users/zitadel-user-9/grants/existing-grant',
    );
    expect(JSON.parse(bodyOf(updateCall))).toEqual({ roleKeys: ['ADMIN'] });
    // A set-role update never adds a second grant nor deletes the existing one. (The only POSTs are
    // the token exchange and the search; there is no POST to the add-grant endpoint.)
    const calls = fetchMock.mock.calls as FetchCall[];
    expect(calls.map((c) => c[1].method)).not.toContain('DELETE');
    const addGrantPosts = calls.filter(
      (c) =>
        c[1].method === 'POST' &&
        c[0].endsWith('/management/v1/users/zitadel-user-9/grants'),
    );
    expect(addGrantPosts).toHaveLength(0);
  });

  it('revokeRole searches by userId+projectId then DELETEs the matched grant', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ id: 'g-mine', projectId: 'project-1' }],
        }),
      ) // search (already scoped to the project)
      .mockResolvedValueOnce(jsonResponse({})); // DELETE g-mine

    await svc.revokeRole('zitadel-user-9');

    const searchCall = callAt(1);
    expect(searchCall[0]).toBe(
      'http://zitadel:8080/management/v1/users/grants/_search',
    );
    expect(JSON.parse(bodyOf(searchCall))).toEqual({
      queries: [
        { userIdQuery: { userId: 'zitadel-user-9' } },
        { projectIdQuery: { projectId: 'project-1' } },
      ],
    });

    const deleteCalls = (fetchMock.mock.calls as FetchCall[]).filter(
      (c) => c[1].method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe(
      'http://zitadel:8080/management/v1/users/zitadel-user-9/grants/g-mine',
    );
  });

  it('revokeRole is a no-op (no DELETE) when the user has no grant on the project', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ result: [] })); // search → empty

    await svc.revokeRole('zitadel-user-9');

    const deleteCalls = (fetchMock.mock.calls as FetchCall[]).filter(
      (c) => c[1].method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('updateUser PUTs the profile and POSTs a PRE-VERIFIED email to the v2 user service — issue #149', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // token
      .mockResolvedValueOnce(jsonResponse({})) // PUT /v2/users/human/{id} (profile)
      .mockResolvedValueOnce(jsonResponse({})); // POST /v2/users/{id}/email

    await svc.updateUser('zitadel-user-9', {
      firstName: 'New',
      lastName: 'Name',
      email: 'new@b.com',
    });

    const profileCall = callAt(1);
    expect(profileCall[1].method).toBe('PUT');
    expect(profileCall[0]).toBe(
      'http://zitadel:8080/v2/users/human/zitadel-user-9',
    );
    expect(JSON.parse(bodyOf(profileCall))).toEqual({
      profile: { givenName: 'New', familyName: 'Name' },
    });

    const emailCall = callAt(2);
    expect(emailCall[1].method).toBe('POST');
    expect(emailCall[0]).toBe(
      'http://zitadel:8080/v2/users/zitadel-user-9/email',
    );
    // Pre-verified: the new address is trusted, so Zitadel does NOT force re-verification (INV-2).
    expect(JSON.parse(bodyOf(emailCall))).toEqual({
      email: 'new@b.com',
      isVerified: true,
    });
  });

  it('updateUser only issues the calls for fields that are present (name-only → no email POST)', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({})); // PUT profile only

    await svc.updateUser('zitadel-user-9', { firstName: 'New' });

    const calls = fetchMock.mock.calls as FetchCall[];
    // token + one PUT; no POST to the email sub-resource.
    expect(calls).toHaveLength(2);
    expect(calls[1][1].method).toBe('PUT');
    const emailPosts = calls.filter((c) => c[0].endsWith('/email'));
    expect(emailPosts).toHaveLength(0);
    expect(JSON.parse(bodyOf(calls[1]))).toEqual({
      profile: { givenName: 'New' },
    });
  });

  it('requestPasswordReset POSTs /v2/users/{id}/password_reset with sendLink (Zitadel emails the link) — issue #149', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({}));

    await svc.requestPasswordReset('zitadel-user-9');

    const call = callAt(1);
    expect(call[1].method).toBe('POST');
    expect(call[0]).toBe(
      'http://zitadel:8080/v2/users/zitadel-user-9/password_reset',
    );
    // sendLink → Zitadel emails the reset link via its own SMTP (vs returnCode which would hand the
    // raw code back to lazyit — we deliberately never handle the credential).
    expect(JSON.parse(bodyOf(call))).toEqual({ sendLink: {} });
  });

  it('a permanent 4xx Management response throws a 503 WITHOUT retrying (no silent partial write)', async () => {
    const svc = configure();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 404));

    await expect(svc.deactivateUser('ext-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // A 404 is permanent — exactly one management call (the token + the single 404), no retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed token exchange throws a 503', async () => {
    const svc = configure();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad' }, 401));

    await expect(svc.deactivateUser('ext-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('absent config: management methods WARN + throw "not configured", never calling fetch', async () => {
    // No ZITADEL_MGMT_* set: the constructor does NOT throw (boot-safe), but the management methods
    // reject with a 503 ("Zitadel management not configured") and never reach the network.
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const svc = new ZitadelManagementService();

    await expect(svc.deactivateUser('ext-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Zitadel management'),
    );
    expect(svc.isConfigured()).toBe(false);
  });

  it('isConfigured() is true only when the SA key, project id AND issuer are all present', () => {
    process.env.ZITADEL_MGMT_SA_KEY = saKeyJson;
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    // Missing ZITADEL_MGMT_PROJECT_ID.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(new ZitadelManagementService().isConfigured()).toBe(false);

    process.env.ZITADEL_MGMT_PROJECT_ID = 'project-1';
    expect(new ZitadelManagementService().isConfigured()).toBe(true);

    // Drop the issuer: write-back cannot sign its assertion without it, so isConfigured() is false.
    delete process.env.OIDC_ISSUER;
    expect(new ZitadelManagementService().isConfigured()).toBe(false);
  });

  it('isConfigured() is true with the project id + SA key supplied by the bootstrap files (zero-touch)', () => {
    // After the boot loader (auth/bootstrap-file.ts) merges oidc-client.json into process.env, the
    // project id + issuer simply appear in env exactly as if pinned. The SA key comes from
    // ZITADEL_MGMT_SA_KEY_PATH (the sidecar's sa-key.json) — here inline-JSON stands in for that read.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.ZITADEL_MGMT_SA_KEY = saKeyJson; // stands in for sa-key.json @ ZITADEL_MGMT_SA_KEY_PATH
    process.env.ZITADEL_MGMT_PROJECT_ID = 'file-project-1'; // from oidc-client.json
    process.env.OIDC_ISSUER = 'https://auth.example.com'; // from oidc-client.json

    const svc = new ZitadelManagementService();
    expect(svc.isConfigured()).toBe(true);
    expect(svc.projectId).toBe('file-project-1');
  });

  // --------- issue #196: friendly 503 message + bounded transient retry --------------------------

  /**
   * A test subclass that makes the retry deterministic: `sleep` records the requested delay and
   * resolves INSTANTLY (no real wall-clock wait → the suite stays fast + deterministic), and `random`
   * returns a fixed value so the jittered backoff is reproducible. Both hooks are `protected` on the
   * service precisely so a test can substitute them.
   */
  class TestableMgmt extends ZitadelManagementService {
    readonly sleeps: number[] = [];
    protected sleep(ms: number): Promise<void> {
      this.sleeps.push(ms);
      return Promise.resolve();
    }
    protected random(): number {
      return 0.5; // mid-window jitter — deterministic, non-zero.
    }
  }

  function configureTestable(): TestableMgmt {
    process.env.ZITADEL_MGMT_SA_KEY = saKeyJson;
    process.env.ZITADEL_MGMT_PROJECT_ID = 'project-1';
    process.env.ZITADEL_MGMT_API_URL = 'http://zitadel:8080';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    return new TestableMgmt();
  }

  describe('issue #196 — friendly 503 + bounded transient retry', () => {
    it('the public 503 message is GENERIC + actionable — no internal verb/path/status leaked', async () => {
      const svc = configure();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // A permanent 404 surfaces immediately (no retry), so the message is the only thing under test.
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 404));

      const err = await svc.deactivateUser('ext-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const message = (err as ServiceUnavailableException).message;
      expect(message).toBe(
        'The identity provider is temporarily unavailable. Your change was not saved, please try again in a moment.',
      );
      // The user-facing message must NOT contain the internal verb/path or the raw upstream status.
      expect(message).not.toMatch(
        /POST|PUT|\/v2\/|\/management\/|404|deactivate/,
      );
    });

    it('the RICH failure detail (verb + path + upstream status) stays in the WARN log', async () => {
      const svc = configure();
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 404));

      await expect(svc.deactivateUser('ext-9')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // The operator-facing log keeps the operation (verb + path) and the raw upstream status.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'POST /v2/users/ext-9/deactivate failed: Management API returned 404',
        ),
      );
    });

    it('retries a transient 503 then SUCCEEDS — invisible to the admin (deactivate, idempotent)', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fetchMock
        .mockResolvedValueOnce(tokenResponse()) // token
        .mockResolvedValueOnce(jsonResponse({ error: 'blip' }, 503)) // 1st: transient
        .mockResolvedValueOnce(jsonResponse({})); // 2nd: recovered

      await expect(svc.deactivateUser('ext-1')).resolves.toBeUndefined();

      // token + 2 management attempts (one 503, one 200); exactly one backoff sleep happened.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(svc.sleeps).toHaveLength(1);
    });

    it('retries 408/429/500/502/503/504 and a network error — but NEVER a 4xx', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      for (const status of [408, 429, 500, 502, 503, 504]) {
        const svc = configureTestable();
        fetchMock.mockReset();
        fetchMock
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ error: 't' }, status)) // transient
          .mockResolvedValueOnce(jsonResponse({})); // recovered
        await expect(svc.deactivateUser('ext-1')).resolves.toBeUndefined();
        expect(svc.sleeps.length).toBeGreaterThanOrEqual(1);
      }

      // A network/transport error is transient too.
      {
        const svc = configureTestable();
        fetchMock.mockReset();
        fetchMock
          .mockResolvedValueOnce(tokenResponse())
          .mockRejectedValueOnce(new Error('ECONNRESET')) // transport blip
          .mockResolvedValueOnce(jsonResponse({})); // recovered
        await expect(svc.deactivateUser('ext-1')).resolves.toBeUndefined();
        expect(svc.sleeps).toHaveLength(1);
      }

      // A permanent 4xx is NEVER retried (no sleep, single attempt → straight to the friendly 503).
      for (const status of [400, 401, 403, 404, 409]) {
        const svc = configureTestable();
        fetchMock.mockReset();
        fetchMock
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ error: 'p' }, status));
        await expect(svc.deactivateUser('ext-1')).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(svc.sleeps).toHaveLength(0);
        expect(fetchMock).toHaveBeenCalledTimes(2); // token + the single 4xx
      }
    });

    it('a SUSTAINED transient outage exhausts the bounded budget then throws the friendly 503 (revert still holds)', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // Every attempt 503s: token + MAX_ATTEMPTS(3) management calls, then it gives up.
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValue(jsonResponse({ error: 'down' }, 503));

      await expect(svc.deactivateUser('ext-1')).rejects.toMatchObject({
        message:
          'The identity provider is temporarily unavailable. Your change was not saved, please try again in a moment.',
      });

      // 3 attempts (1 + 2 retries) => exactly 2 sleeps; total added latency is bounded well under ~2s.
      expect(svc.sleeps).toHaveLength(2);
      const total = svc.sleeps.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(1_800);
      // token + 3 management attempts.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('honours Retry-After (seconds) on a 503, clamped to the per-sleep budget', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 503, 0.4)) // Retry-After: 0.4s = 400ms
        .mockResolvedValueOnce(jsonResponse({}));

      await expect(svc.deactivateUser('ext-1')).resolves.toBeUndefined();
      // The honoured wait is the Retry-After value (400ms), not the jittered default.
      expect(svc.sleeps).toEqual([400]);
    });

    it('does NOT retry the non-idempotent grant-ADD POST on a transient 503 (avoids a duplicate grant)', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fetchMock
        .mockResolvedValueOnce(tokenResponse()) // token
        .mockResolvedValueOnce(jsonResponse({ result: [] })) // search → no existing grant
        .mockResolvedValueOnce(jsonResponse({ error: 'blip' }, 503)); // ADD grant → transient 503

      await expect(svc.grantRole('ext-1', 'ADMIN')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // No retry on the ADD: token + search + a single ADD attempt, and ZERO sleeps.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(svc.sleeps).toHaveLength(0);
    });

    it('DOES retry the idempotent grant-UPDATE PUT on a transient 503', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fetchMock
        .mockResolvedValueOnce(tokenResponse()) // token
        .mockResolvedValueOnce(
          jsonResponse({ result: [{ id: 'g-1', projectId: 'project-1' }] }),
        ) // search → existing grant
        .mockResolvedValueOnce(jsonResponse({ error: 'blip' }, 503)) // PUT → transient 503
        .mockResolvedValueOnce(jsonResponse({})); // PUT retry → recovered

      await expect(svc.grantRole('ext-1', 'ADMIN')).resolves.toBeUndefined();
      // The PUT (set-roles, idempotent) is retried: token + search + 2 PUT attempts; one sleep.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(svc.sleeps).toHaveLength(1);
    });

    it('does NOT retry the non-idempotent createUser POST /v2/users/human on a transient 503', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fetchMock
        .mockResolvedValueOnce(tokenResponse()) // token
        .mockResolvedValueOnce(jsonResponse({ error: 'blip' }, 503)); // create → transient 503

      await expect(
        svc.createUser({
          email: 'a@b.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          role: 'MEMBER',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // No retry on create: token + a single create attempt, ZERO sleeps (no duplicate-user risk).
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(svc.sleeps).toHaveLength(0);
    });

    it('does NOT retry a getAccessToken (auth) failure', async () => {
      const svc = configureTestable();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // The token endpoint itself 503s — auth path, not a Management call: no retry, no sleep.
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'down' }, 503));

      await expect(svc.deactivateUser('ext-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the token attempt
      expect(svc.sleeps).toHaveLength(0);
    });
  });

  // --------- issue #219: request-id-correlated management WARN logs ------------------------------

  describe('issue #219 — request-correlatable management WARN logs', () => {
    /**
     * A stand-in for the request-scoped nestjs-pino {@link PinoLogger}: records `warn(fields, msg)`
     * calls so the test can assert the STRUCTURED shape, and a `setContext`/`assign` no-op so the
     * service can wire it like the real logger. In the wired app the real PinoLogger reads the
     * request's child logger (with `req.id`/`actor`) from AsyncLocalStorage AT LOG TIME — that part is
     * nestjs-pino's contract (ADR-0031) and is not re-tested here; what we prove is that the service
     * ROUTES its WARNs through the injected logger with the verb/path/upstream-status metadata an
     * operator needs to correlate, and never the SA key (INV-6).
     */
    class FakePinoLogger {
      readonly warns: { fields: unknown; msg: string }[] = [];
      context = '';
      setContext(ctx: string): void {
        this.context = ctx;
      }
      warn(fields: unknown, msg: string): void {
        this.warns.push({ fields, msg });
      }
    }

    /** Configure a fully-wired service that logs through the injected (fake) request-scoped logger. */
    function configureWithLogger(logger: FakePinoLogger): ZitadelManagementService {
      process.env.ZITADEL_MGMT_SA_KEY = saKeyJson;
      process.env.ZITADEL_MGMT_PROJECT_ID = 'project-1';
      process.env.ZITADEL_MGMT_API_URL = 'http://zitadel:8080';
      process.env.OIDC_ISSUER = 'https://auth.example.com';
      // The DI seam: the IdP adapter threads the request-scoped PinoLogger in here (issue #219).
      return new ZitadelManagementService(
        logger as unknown as import('nestjs-pino').PinoLogger,
      );
    }

    it('routes the failing-call WARN through the injected request logger with structured verb/path/upstream-status fields', async () => {
      // Spy on the static Logger BEFORE the call: when a request logger is present it must NOT be used
      // (no double log / no uncorrelated line). Spying after the fact would assert nothing.
      const staticWarn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const logger = new FakePinoLogger();
      const svc = configureWithLogger(logger);
      // A sustained 503 on the human-profile PUT — the exact #219 symptom (updateUser, last-name edit).
      fetchMock
        .mockResolvedValueOnce(tokenResponse()) // token
        .mockResolvedValue(jsonResponse({ error: 'down' }, 503)); // every attempt 503s

      await expect(
        svc.updateUser('zitadel-user-9', { lastName: 'Renamed' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // The FINAL failure WARN (after the bounded retry is exhausted) carries the structured shape so
      // an operator can correlate it with the X-Request-Id the browser saw (ADR-0031).
      const failWarn = logger.warns.find((w) =>
        w.msg.includes('failed: Management API returned 503'),
      );
      expect(failWarn).toBeDefined();
      expect(failWarn!.fields).toMatchObject({
        operation: 'PUT /v2/users/human/zitadel-user-9',
        method: 'PUT',
        path: '/v2/users/human/zitadel-user-9',
        upstreamStatus: 503,
      });
      // Every retry WARN + the final failure WARN went through the injected logger, not the static one.
      expect(staticWarn).not.toHaveBeenCalled();
    });

    it('NEVER includes the service-account key/token in any logged WARN (INV-6)', async () => {
      const logger = new FakePinoLogger();
      const svc = configureWithLogger(logger);
      fetchMock
        .mockResolvedValueOnce(tokenResponse('super-secret-mgmt-token')) // token (must never leak)
        .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 404)); // permanent → single WARN

      await expect(svc.deactivateUser('ext-9')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(logger.warns.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(logger.warns);
      // Neither the SA key PEM, the assertion, nor the access token may appear in the structured log.
      expect(serialized).not.toContain('super-secret-mgmt-token');
      expect(serialized).not.toContain('signed.jwt.assertion');
      expect(serialized).not.toContain('PRIVATE KEY');
    });

    it('falls back to the static Logger (single-line message) when NO request logger is injected', async () => {
      // The unit-test / boot path: `new ZitadelManagementService()` with no logger still WARNs, via
      // the static @nestjs/common Logger, preserving the existing operator-facing single-line message.
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const svc = configure(); // no logger argument
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 404));

      await expect(svc.deactivateUser('ext-9')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'POST /v2/users/ext-9/deactivate failed: Management API returned 404',
        ),
      );
    });
  });
});
