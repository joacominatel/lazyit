import { validateBootConfig } from './boot-config';

// validateBootConfig calls process.exit(1) on a bad config; spy on it so the test process survives
// and we can assert it was (or was not) called. The spy throws a sentinel so control flow stops at
// the exit point, mirroring the real "never returns" behaviour.
class ExitCalled extends Error {}

describe('validateBootConfig (fail-loud boot config)', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new ExitCalled();
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const OIDC_OK = {
    // AUTH_MODE is now EXPLICIT-REQUIRED (ADR-0086 §2) — an unset value no longer implies OIDC.
    AUTH_MODE: 'oidc',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    OIDC_ISSUER: 'https://auth.example.com',
    OIDC_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
    WEB_ORIGIN: 'http://localhost:3000',
  };

  const LOCAL_OK = {
    AUTH_MODE: 'local',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    // ≥32 chars (ADR-0086 §4) — length-asserted like WORKFLOW_SECRET_KEY.
    SESSION_SIGNING_SECRET: 'a'.repeat(48),
  };

  it('accepts a valid OIDC config (optional MEILI/import vars stay optional)', () => {
    expect(() => validateBootConfig({ ...OIDC_OK })).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid shim config (no OIDC vars required)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'shim',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid local config (SESSION_SIGNING_SECRET present + long enough)', () => {
    expect(() => validateBootConfig({ ...LOCAL_OK })).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('EXITS when AUTH_MODE is unset (explicit-required — unset no longer means OIDC)', () => {
    expect(() =>
      validateBootConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).toContain('CRITICAL');
    expect(logged).toContain('AUTH_MODE');
    // The message steers an existing OIDC deploy to set the mode explicitly.
    expect(logged).toContain('AUTH_MODE=oidc');
  });

  it('EXITS when AUTH_MODE is an unrecognized value (enum error)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'sso',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when DATABASE_URL is missing', () => {
    expect(() => validateBootConfig({ AUTH_MODE: 'shim' })).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('EXITS in local mode when SESSION_SIGNING_SECRET is missing (names it in the log)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'local',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).toContain('SESSION_SIGNING_SECRET');
  });

  it('EXITS in local mode when SESSION_SIGNING_SECRET is too short (< 32 chars)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'local',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        SESSION_SIGNING_SECRET: 'too-short',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).toContain('SESSION_SIGNING_SECRET');
  });

  it('exits in OIDC mode when OIDC_ISSUER / OIDC_JWKS_URI are missing (names them in the log)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'oidc',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).toContain('CRITICAL');
    expect(logged).toContain('OIDC_ISSUER');
    expect(logged).toContain('OIDC_JWKS_URI');
  });

  it('REFUSES AUTH_MODE=shim in production (the prod safeguard)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'shim',
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).toContain('AUTH_MODE');
  });

  it('exits when WEB_ORIGIN is not a valid URL', () => {
    expect(() =>
      validateBootConfig({
        ...OIDC_OK,
        WEB_ORIGIN: 'not-a-url',
      }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts LAN host-agnostic mode (AUTH_TRUST_HOST=true, no WEB_ORIGIN, AUTH_MODE=local)', () => {
    expect(() =>
      validateBootConfig({ ...LOCAL_OK, AUTH_TRUST_HOST: 'true' }),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('EXITS when AUTH_TRUST_HOST=true with a non-local AUTH_MODE (names AUTH_TRUST_HOST)', () => {
    expect(() =>
      validateBootConfig({ ...OIDC_OK, AUTH_TRUST_HOST: 'true' }),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).toContain('AUTH_TRUST_HOST');
  });
});
