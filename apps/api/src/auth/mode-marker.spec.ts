import { decideModeMarker } from './mode-marker';

describe('decideModeMarker (persisted auth-mode marker — ADR-0086 §1)', () => {
  it('ACCEPTS when the marker is unset (null) — fresh install / not yet through /setup', () => {
    expect(decideModeMarker(null, 'local')).toEqual({ ok: true });
    expect(decideModeMarker(null, 'oidc')).toEqual({ ok: true });
    expect(decideModeMarker(null, 'shim')).toEqual({ ok: true });
  });

  it('ACCEPTS when the marker is undefined or an empty string (no row / blank)', () => {
    expect(decideModeMarker(undefined, 'oidc')).toEqual({ ok: true });
    expect(decideModeMarker('', 'oidc')).toEqual({ ok: true });
  });

  it('ACCEPTS when the stored marker matches env.AUTH_MODE', () => {
    expect(decideModeMarker('local', 'local')).toEqual({ ok: true });
    expect(decideModeMarker('oidc', 'oidc')).toEqual({ ok: true });
    expect(decideModeMarker('shim', 'shim')).toEqual({ ok: true });
  });

  it('REFUSES (fail-loud) when the stored marker differs from env.AUTH_MODE', () => {
    const decision = decideModeMarker('oidc', 'local');
    expect(decision.ok).toBe(false);
    // The message names both modes and steers the operator back to the persisted one.
    expect(decision.message).toContain('AUTH_MODE=local');
    expect(decision.message).toContain('oidc');
    expect(decision.message).toContain('AUTH_MODE=oidc');
    expect(decision.message).toContain('immutable');
  });

  it('REFUSES when env.AUTH_MODE is undefined but a marker is set', () => {
    const decision = decideModeMarker('local', undefined);
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain('(unset)');
    expect(decision.message).toContain('local');
  });
});
