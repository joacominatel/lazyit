import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '../../../generated/prisma/client';
import {
  PasswordResetUnsupportedError,
  type CreateIdentityUserInput,
  type ExternalRef,
  type IdentityProvider,
  type UpdateIdentityUserInput,
} from './identity-provider.interface';

/**
 * GenericOidcIdentityProvider — the BYOI ("bring your own IdP") implementation (ADR-0043 decision #5).
 *
 * When the operator points lazyit at their own OIDC provider, lazyit has no portable, standard way to
 * MANAGE users in it (OIDC standardizes login, not user administration). So the management surface
 * degrades to a structured no-op: each method logs a `warn` and returns without side effects, rather
 * than throwing — the local DB stays the source of truth for roles (RolesGuard reads from the DB,
 * ADR-0043 decision #1) and the IdP mirror is simply skipped.
 *
 * `resolveExternalRef` is fully functional: the OIDC `sub` IS the external reference lazyit stores.
 */
@Injectable()
export class GenericOidcIdentityProvider implements IdentityProvider {
  private readonly logger = new Logger(GenericOidcIdentityProvider.name);

  readonly kind = 'generic-oidc';
  readonly supportsManagement = false;

  resolveExternalRef(sub: string): Promise<ExternalRef> {
    return Promise.resolve({ externalId: sub });
  }

  createUser(input: CreateIdentityUserInput): Promise<ExternalRef> {
    this.warnUnsupported('createUser', { email: input.email });
    // No external id exists (nothing was created); return the email-less placeholder is not useful,
    // so we surface that there is no IdP-side ref by echoing nothing meaningful. Callers that need a
    // real ref must check `supportsManagement` first. Phase 1 has no such caller.
    return Promise.resolve({ externalId: '' });
  }

  deactivateUser(externalId: string): Promise<void> {
    this.warnUnsupported('deactivateUser', { externalId });
    return Promise.resolve();
  }

  grantRole(externalId: string, role: Role): Promise<void> {
    this.warnUnsupported('grantRole', { externalId, role });
    return Promise.resolve();
  }

  revokeRole(externalId: string, role: Role): Promise<void> {
    this.warnUnsupported('revokeRole', { externalId, role });
    return Promise.resolve();
  }

  updateUser(
    externalId: string,
    input: UpdateIdentityUserInput,
  ): Promise<void> {
    // BYOI: no portable way to write a profile/email back. No-op + warn (the local DB still updated).
    // Honest: lazyit's row changes, the IdP mirror is skipped — same posture as the other writes.
    this.warnUnsupported('updateUser', {
      externalId,
      fields: Object.keys(input),
    });
    return Promise.resolve();
  }

  requestPasswordReset(externalId: string): Promise<void> {
    // BYOI: lazyit cannot trigger a reset on a foreign OIDC IdP. Unlike the mirror writes, this is a
    // user-visible ACTION — a silent no-op would falsely imply "a reset was sent". So we REJECT with a
    // typed error the controller maps to a 501 "managed by your identity provider" (INV-4), never a 2xx.
    this.warnUnsupported('requestPasswordReset', { externalId });
    return Promise.reject(new PasswordResetUnsupportedError());
  }

  /** Structured warn used by every degraded management method (BYOI no-op, ADR-0043 #5). */
  private warnUnsupported(
    operation: string,
    context: Record<string, unknown>,
  ): void {
    this.logger.warn(
      `IdP management not supported for generic OIDC IdP; skipping ${operation} (lazyit DB remains the role source). ${JSON.stringify(
        context,
      )}`,
    );
  }
}
