import { validateBootConfig } from './boot-config';

// validateBootConfig calls process.exit(1) on a bad config; spy on it so the test process survives
// and we can assert it was (or was not) called. The spy throws a sentinel so control flow stops at
// the exit point, mirroring the real "never returns" behaviour.
class ExitCalled extends Error {}

describe('validateBootConfig (fail-loud boot config)', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new ExitCalled();
    }) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const OIDC_OK = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    OIDC_ISSUER: 'https://auth.example.com',
    OIDC_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
    WEB_ORIGIN: 'http://localhost:3000',
  };

  it('accepts a valid OIDC config (optional MEILI/import vars stay optional)', () => {
    expect(() =>
      validateBootConfig({ ...OIDC_OK } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid shim config (no OIDC vars required)', () => {
    expect(() =>
      validateBootConfig({
        AUTH_MODE: 'shim',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits when DATABASE_URL is missing', () => {
    expect(() =>
      validateBootConfig({ AUTH_MODE: 'shim' } as NodeJS.ProcessEnv),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits in OIDC mode when OIDC_ISSUER / OIDC_JWKS_URI are missing (names them in the log)', () => {
    expect(() =>
      validateBootConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      } as NodeJS.ProcessEnv),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
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
      } as NodeJS.ProcessEnv),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('AUTH_MODE');
  });

  it('exits when WEB_ORIGIN is not a valid URL', () => {
    expect(() =>
      validateBootConfig({
        ...OIDC_OK,
        WEB_ORIGIN: 'not-a-url',
      } as NodeJS.ProcessEnv),
    ).toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
