import type { Role } from '../../../generated/prisma/client';

// Kept only until its callers are gone: no remaining implementation manages users (ADR-0102 §6). Authorization stays DB-first.
export interface IdentityProvider {
  /** The active implementation: "generic-oidc" or "local". */
  readonly kind: string;

  /** Always `false` since the bundled Zitadel was removed; the management methods below are no-ops. */
  readonly supportsManagement: boolean;

  /** The OIDC `sub` is the external id lazyit stores on `User.externalId`. */
  resolveExternalRef(sub: string): Promise<ExternalRef>;

  /** No-op: returns an empty external id. */
  createUser(input: CreateIdentityUserInput): Promise<ExternalRef>;

  /** No-op. */
  deactivateUser(externalId: string): Promise<void>;

  /** No-op. */
  grantRole(externalId: string, role: Role): Promise<void>;

  /** No-op. */
  revokeRole(externalId: string, role: Role): Promise<void>;

  /** No-op. */
  updateUser(externalId: string, input: UpdateIdentityUserInput): Promise<void>;

  /** Rejects with {@link PasswordResetUnsupportedError}: a silent no-op would imply a reset was sent (INV-4). */
  requestPasswordReset(externalId: string): Promise<void>;
}

/** An IdP identity reference resolved from a `sub`. */
export interface ExternalRef {
  /** The identifier lazyit persists as `User.externalId` (the OIDC `sub`). */
  externalId: string;
}

/** Input for {@link IdentityProvider.createUser}. */
export interface CreateIdentityUserInput {
  email: string;
  firstName: string;
  lastName: string;
  /** Ignored by every remaining provider. */
  role: Role;
  /** Ignored by every remaining provider. */
  password?: string;
  /** Ignored by every remaining provider. */
  passwordChangeRequired?: boolean;
}

/** Input for {@link IdentityProvider.updateUser}; the target is the `externalId` argument, never re-linked (SEC-006). */
export interface UpdateIdentityUserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
}

/**
 * Thrown by {@link IdentityProvider.requestPasswordReset} when the active provider cannot trigger a
 * reset (BYOI / generic OIDC). The Users controller maps it to a 501 Not Implemented with an honest
 * "managed by your identity provider" message — NEVER a 2xx that pretends a reset was sent (INV-4).
 * A distinct error type (not a generic throw) lets the controller branch on capability cleanly.
 */
export class PasswordResetUnsupportedError extends Error {
  constructor(
    message = 'Password reset is managed by your identity provider; lazyit cannot trigger it.',
  ) {
    super(message);
    this.name = 'PasswordResetUnsupportedError';
  }
}

/** DI token for the configured {@link IdentityProvider}; an interface has no runtime value to inject by. */
export const IDENTITY_PROVIDER = 'IDENTITY_PROVIDER';
