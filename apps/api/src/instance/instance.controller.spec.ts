import { InstanceController } from './instance.controller';

/**
 * GET /instance/version (ADR-0083). The controller snapshots APP_VERSION / GIT_SHA from the env at
 * construction, so each case builds a fresh controller under a mutated `process.env` and restores it
 * afterwards. No Nest testing module needed — the controller has zero dependencies.
 */
describe('InstanceController', () => {
  const ORIGINAL = {
    APP_VERSION: process.env.APP_VERSION,
    GIT_SHA: process.env.GIT_SHA,
  };

  afterEach(() => {
    for (const key of ['APP_VERSION', 'GIT_SHA'] as const) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  it('returns the baked build identity when the env is injected', () => {
    process.env.APP_VERSION = 'v1.4.2';
    process.env.GIT_SHA = 'abc1234';
    expect(new InstanceController().getVersion()).toEqual({
      current: 'v1.4.2',
      gitSha: 'abc1234',
    });
  });

  it('passes the honest off-tag describe form through untouched', () => {
    process.env.APP_VERSION = 'v1.4.2-3-gabc1234';
    process.env.GIT_SHA = 'abc1234';
    expect(new InstanceController().getVersion().current).toBe(
      'v1.4.2-3-gabc1234',
    );
  });

  it('falls back to dev/unknown when nothing was injected (native dev run)', () => {
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    expect(new InstanceController().getVersion()).toEqual({
      current: 'dev',
      gitSha: 'unknown',
    });
  });

  it('treats empty-string env values as absent (fallbacks apply)', () => {
    process.env.APP_VERSION = '';
    process.env.GIT_SHA = '';
    expect(new InstanceController().getVersion()).toEqual({
      current: 'dev',
      gitSha: 'unknown',
    });
  });
});
