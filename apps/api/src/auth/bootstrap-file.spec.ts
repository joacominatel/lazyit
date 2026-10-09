// Mock node:fs BEFORE importing the loader so readFileSync is the jest mock the tests drive.
jest.mock('node:fs', () => ({ readFileSync: jest.fn() }));
import { readFileSync } from 'node:fs';

import {
  DEFAULT_OIDC_CLIENT_FILE,
  loadBootstrapOidcFile,
} from './bootstrap-file';

const readFileSyncMock = readFileSync as unknown as jest.Mock;

/**
 * loadBootstrapOidcFile (ADR-0043 Phase 3) — the zero-touch bridge that lets the api CONSUME the
 * sidecar's oidc-client.json at boot. fs is mocked (no real file). We assert: the file fills unset
 * OIDC_* / ZITADEL_MGMT_PROJECT_ID, explicit env always overrides the file, an absent file is a
 * silent no-op (env-only path unchanged), OIDC_CLIENT_FILE redirects the path, and secrets are never
 * logged.
 */
describe('loadBootstrapOidcFile (zero-touch OIDC file)', () => {
  /** A complete sidecar oidc-client.json, as infra/scripts/zitadel-bootstrap.sh §3e writes it. */
  const FILE_JSON = JSON.stringify({
    OIDC_ISSUER: 'https://auth.example.com',
    OIDC_CLIENT_ID: 'file-client-id',
    OIDC_CLIENT_SECRET: 'file-client-secret',
    OIDC_JWKS_URI: 'http://zitadel:8080/oauth/v2/keys',
    ZITADEL_MGMT_PROJECT_ID: 'file-project-1',
  });

  let warn: jest.Mock<void, [string]>;

  beforeEach(() => {
    readFileSyncMock.mockReset();
    warn = jest.fn<void, [string]>();
  });

  it('fills every unset OIDC_* and the project id from the file', () => {
    readFileSyncMock.mockReturnValue(FILE_JSON);
    const env: NodeJS.ProcessEnv = {};

    const filled = loadBootstrapOidcFile(env, warn);

    expect(env.OIDC_ISSUER).toBe('https://auth.example.com');
    expect(env.OIDC_CLIENT_ID).toBe('file-client-id');
    expect(env.OIDC_CLIENT_SECRET).toBe('file-client-secret');
    expect(env.OIDC_JWKS_URI).toBe('http://zitadel:8080/oauth/v2/keys');
    expect(env.ZITADEL_MGMT_PROJECT_ID).toBe('file-project-1');
    expect(filled).toEqual(
      expect.arrayContaining([
        'OIDC_ISSUER',
        'OIDC_CLIENT_ID',
        'OIDC_CLIENT_SECRET',
        'OIDC_JWKS_URI',
        'ZITADEL_MGMT_PROJECT_ID',
      ]),
    );
    // Reads the default mount path when OIDC_CLIENT_FILE is unset.
    expect(readFileSyncMock).toHaveBeenCalledWith(
      DEFAULT_OIDC_CLIENT_FILE,
      'utf8',
    );
  });

  it('explicit env ALWAYS overrides the file (BYOI / pinned vars win)', () => {
    readFileSyncMock.mockReturnValue(FILE_JSON);
    const env: NodeJS.ProcessEnv = {
      OIDC_ISSUER: 'https://byoi.okta.com',
      OIDC_CLIENT_ID: 'env-client',
    };

    const filled = loadBootstrapOidcFile(env, warn);

    // Pinned vars are untouched; only the gaps come from the file.
    expect(env.OIDC_ISSUER).toBe('https://byoi.okta.com');
    expect(env.OIDC_CLIENT_ID).toBe('env-client');
    expect(env.OIDC_CLIENT_SECRET).toBe('file-client-secret');
    expect(env.ZITADEL_MGMT_PROJECT_ID).toBe('file-project-1');
    expect(filled).not.toContain('OIDC_ISSUER');
    expect(filled).not.toContain('OIDC_CLIENT_ID');
  });

  it('an absent file is a silent no-op (env-only path unchanged)', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const env: NodeJS.ProcessEnv = { OIDC_ISSUER: 'https://byoi.okta.com' };

    const filled = loadBootstrapOidcFile(env, warn);

    expect(filled).toEqual([]);
    expect(env.OIDC_ISSUER).toBe('https://byoi.okta.com');
    expect(env.OIDC_CLIENT_ID).toBeUndefined();
    // No WARN for the normal BYOI / env-only case.
    expect(warn).not.toHaveBeenCalled();
  });

  it('honours OIDC_CLIENT_FILE to redirect the file path', () => {
    readFileSyncMock.mockReturnValue(FILE_JSON);
    const env: NodeJS.ProcessEnv = {
      OIDC_CLIENT_FILE: '/custom/oidc.json',
    };

    loadBootstrapOidcFile(env, warn);

    expect(readFileSyncMock).toHaveBeenCalledWith('/custom/oidc.json', 'utf8');
  });

  it('malformed JSON degrades to env-only with a WARN that leaks no secret', () => {
    readFileSyncMock.mockReturnValue('{ not valid json');
    const env: NodeJS.ProcessEnv = {};

    const filled = loadBootstrapOidcFile(env, warn);

    expect(filled).toEqual([]);
    expect(env.OIDC_CLIENT_SECRET).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never logs secret values — only the names of filled vars', () => {
    readFileSyncMock.mockReturnValue(FILE_JSON);
    const env: NodeJS.ProcessEnv = {};

    loadBootstrapOidcFile(env, warn);

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('file-client-secret');
    expect(logged).not.toContain('file-client-id');
    // It DOES name the vars it filled (so an operator sees the file took effect).
    expect(logged).toContain('OIDC_CLIENT_SECRET');
  });
});
