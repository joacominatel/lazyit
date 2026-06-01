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
 * is NO live Zitadel. We assert: the service-account token is fetched once and reused (cache), each v2
 * call hits the right method/path/body, a non-2xx maps to a 503 ServiceUnavailableException (surfaced
 * upstream as 503), and an absent credential WARNs + throws "not configured" without ever blocking.
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

  /** A successful JSON Response for a v2 call. */
  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
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
      .mockResolvedValueOnce(jsonResponse({ result: [] })) // grantRole → list (revoke is no-op)
      .mockResolvedValueOnce(jsonResponse({ userGrantId: 'g-1' })); // grantRole → add grant

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

    // The role grant carries the project id + the mapped MEMBER role key.
    const grantCall = callAt(3);
    expect(grantCall[0]).toBe(
      'http://zitadel:8080/v2/users/zitadel-user-7/grants',
    );
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

  it('grantRole revokes the existing grant then adds the new one (revoke-then-grant)', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // token
      // grantRole → revokeRole lists grants: one existing grant on the project.
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ id: 'old-grant', projectId: 'project-1' }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({})) // DELETE old grant
      .mockResolvedValueOnce(jsonResponse({ userGrantId: 'new-grant' })); // POST new grant

    await svc.grantRole('zitadel-user-9', 'ADMIN');

    const deleteCall = callAt(2);
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[0]).toBe(
      'http://zitadel:8080/v2/users/zitadel-user-9/grants/old-grant',
    );
    const addCall = callAt(3);
    expect(addCall[1].method).toBe('POST');
    expect(JSON.parse(bodyOf(addCall))).toEqual({
      projectId: 'project-1',
      roleKeys: ['ADMIN'],
    });
  });

  it('revokeRole DELETEs only grants on the configured project', async () => {
    const svc = configure();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          result: [
            { id: 'g-other', projectId: 'other-project' },
            { id: 'g-mine', projectId: 'project-1' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({})); // DELETE g-mine

    await svc.revokeRole('zitadel-user-9');

    const deleteCalls = (fetchMock.mock.calls as FetchCall[]).filter(
      (c) => c[1].method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe(
      'http://zitadel:8080/v2/users/zitadel-user-9/grants/g-mine',
    );
  });

  it('a non-2xx Management response throws a 503 (no silent partial write)', async () => {
    const svc = configure();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

    await expect(svc.deactivateUser('ext-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
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
});
