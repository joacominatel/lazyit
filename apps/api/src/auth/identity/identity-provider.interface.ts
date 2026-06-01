import type { Role } from '../../../generated/prisma/client';

/**
 * IdentityProvider — the IdP management surface the auth epic (ADR-0043) writes through.
 *
 * lazyit is DB-first for AUTHORIZATION (ADR-0043 decision #1): the RolesGuard always reads
 * `request.user.role` from the local DB and NEVER trusts a token role claim. The IdP is treated as a
 * MIRROR the app writes to (so an operator managing users in Zitadel sees lazyit's role decisions),
 * not as an authorization source. This interface is that write-back seam.
 *
 * Phase 1 (this PR) is pure SCAFFOLDING — the implementations are a stub (Zitadel) and a degraded
 * no-op (generic OIDC); no guard/service calls them yet. Phase 2 fills the Zitadel adapter with real
 * Management-API calls. Keeping the seam now lets the rest of the epic depend on a stable contract.
 *
 * BYOI (ADR-0043 decision #5): when the operator brings their own OIDC IdP we cannot manage it, so the
 * management methods degrade to a no-op (logged warn) rather than failing — lazyit stays the source of
 * truth for roles in its own DB; the mirror is simply skipped.
 */
export interface IdentityProvider {
  /**
   * A short identifier for the active implementation (e.g. "zitadel", "generic-oidc"). Useful for
   * logging and for callers that want to branch on capability without instanceof checks.
   */
  readonly kind: string;

  /**
   * Whether this provider supports write-back management (createUser / deactivateUser / role
   * grant+revoke). `false` for BYOI / generic OIDC, where those methods are no-ops. Callers can read
   * this to skip a mirror write entirely instead of relying on the no-op.
   */
  readonly supportsManagement: boolean;

  /**
   * Resolve an IdP identity reference from the OIDC `sub`. Phase 1 returns `{ externalId: sub }` for
   * both implementations (the `sub` IS the external id lazyit stores on `User.externalId`). Phase 2
   * may enrich this for Zitadel (e.g. resolving the Zitadel user id distinct from the token sub).
   */
  resolveExternalRef(sub: string): Promise<ExternalRef>;

  /**
   * Provision a user in the IdP (mirror of an app-created lazyit user). No-op for generic OIDC;
   * Phase-2 Zitadel implementation will call the Management API. Returns the external reference of the
   * created (or already-existing) IdP user.
   */
  createUser(input: CreateIdentityUserInput): Promise<ExternalRef>;

  /**
   * Deactivate (disable) the IdP user with the given external id — the mirror of a lazyit offboarding.
   * No-op for generic OIDC.
   */
  deactivateUser(externalId: string): Promise<void>;

  /**
   * Mirror a lazyit role grant onto the IdP (e.g. add a Zitadel project role). No-op for generic OIDC.
   * The local DB remains the authorization source regardless (ADR-0043 decision #1).
   */
  grantRole(externalId: string, role: Role): Promise<void>;

  /**
   * Mirror a lazyit role revocation onto the IdP. No-op for generic OIDC.
   */
  revokeRole(externalId: string, role: Role): Promise<void>;
}

/** An IdP identity reference resolved from a `sub`. Phase 1 carries just the external id. */
export interface ExternalRef {
  /** The IdP-side identifier lazyit persists as `User.externalId` (the OIDC `sub` in Phase 1). */
  externalId: string;
}

/** Input for {@link IdentityProvider.createUser} — the minimal profile to mirror into the IdP. */
export interface CreateIdentityUserInput {
  email: string;
  firstName: string;
  lastName: string;
  /** The role lazyit assigned locally; mirrored to the IdP when management is supported. */
  role: Role;
}

/**
 * DI token for the configured {@link IdentityProvider}. An `interface` has no runtime value to inject
 * by, so providers are wired against this string token (see AuthModule's factory keyed on
 * IDENTITY_PROVIDER_TYPE). Inject with `@Inject(IDENTITY_PROVIDER)`.
 */
export const IDENTITY_PROVIDER = 'IDENTITY_PROVIDER';
