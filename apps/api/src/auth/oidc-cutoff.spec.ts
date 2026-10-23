import {
  issuedBeforeOidcCutoff,
  OIDC_CUTOFF_SKEW_SECONDS,
} from './oidc-cutoff';

/**
 * The OIDC cutoff predicate (#1715): which IdP access tokens "Sign out everywhere" (and a deactivation or
 * offboarding) ends. Times are NumericDates (seconds), as in the token.
 */

const CUTOFF_S = 1_800_000_000;
const CUTOFF = new Date(CUTOFF_S * 1000);

describe('issuedBeforeOidcCutoff', () => {
  it('never refuses when there is no cutoff (every user until they use the action)', () => {
    expect(issuedBeforeOidcCutoff({ iat: 1 }, null)).toBe(false);
    expect(issuedBeforeOidcCutoff({ iat: 1 }, undefined)).toBe(false);
    // Even a token whose age cannot be established: no cutoff, no change from before the upgrade.
    expect(issuedBeforeOidcCutoff({}, null)).toBe(false);
  });

  it('refuses a token issued before the cutoff and accepts one issued after it', () => {
    expect(issuedBeforeOidcCutoff({ iat: CUTOFF_S - 3600 }, CUTOFF)).toBe(true);
    expect(issuedBeforeOidcCutoff({ iat: CUTOFF_S + 5 }, CUTOFF)).toBe(false);
  });

  it(`tolerates ${OIDC_CUTOFF_SKEW_SECONDS}s of clock skew, and not one second more`, () => {
    const edge = CUTOFF_S - OIDC_CUTOFF_SKEW_SECONDS;
    expect(issuedBeforeOidcCutoff({ iat: edge }, CUTOFF)).toBe(false);
    expect(issuedBeforeOidcCutoff({ iat: edge - 1 }, CUTOFF)).toBe(true);
  });

  it('refuses a token RENEWED after the cutoff from a sign-in made before it (auth_time)', () => {
    // What a refresh-token grant returns on another device: a fresh iat, the original auth_time.
    expect(
      issuedBeforeOidcCutoff(
        { iat: CUTOFF_S + 600, auth_time: CUTOFF_S - 3600 },
        CUTOFF,
      ),
    ).toBe(true);
  });

  it('accepts a real sign-in after the cutoff (both claims later)', () => {
    expect(
      issuedBeforeOidcCutoff(
        { iat: CUTOFF_S + 60, auth_time: CUTOFF_S + 55 },
        CUTOFF,
      ),
    ).toBe(false);
  });

  it('judges by iat alone when the IdP does not put auth_time in the access token', () => {
    expect(issuedBeforeOidcCutoff({ iat: CUTOFF_S + 600 }, CUTOFF)).toBe(false);
  });

  it('fails closed when a cutoff exists and the token carries no usable time claim', () => {
    expect(issuedBeforeOidcCutoff({}, CUTOFF)).toBe(true);
    expect(issuedBeforeOidcCutoff({ iat: 'yesterday' } as never, CUTOFF)).toBe(
      true,
    );
    // A malformed auth_time is ignored; the token is judged by its iat.
    expect(
      issuedBeforeOidcCutoff({ iat: CUTOFF_S + 60, auth_time: 'now' }, CUTOFF),
    ).toBe(false);
  });
});
