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
 * LocalIdentityProvider — the AUTH_MODE=local implementation of the IdP write-back seam (ADR-0086 §5).
 *
 * A PURE NO-OP. In local mode lazyit owns username/email + password credentials DIRECTLY; there is no
 * external IdP to mirror to. The `IdentityProvider` seam is specifically about *mirroring to a foreign
 * IdP*, so in local mode every management method is inert (`supportsManagement=false`, same posture as
 * BYOI/generic-OIDC). The actual credential logic lives OUTSIDE this class — in the
 * `LocalCredentialService` (hash/verify/session) + `LocalProvisioningService` (set-password/temp-password),
 * which the Users/Config services call in their `kind==='local'` branches. This provider never touches a
 * password, a DB row, or Secret-Manager key material.
 *
 * `kind='local'` is the signal the Users/Config services branch on (equivalently `AUTH_MODE==='local'`) to
 * take the local credential path instead of the OIDC mirror path. Selected by the identity-provider
 * factory when `AUTH_MODE=local`, regardless of `IDENTITY_PROVIDER_TYPE`.
 */
@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  private readonly logger = new Logger(LocalIdentityProvider.name);

  readonly kind = 'local';
  readonly supportsManagement = false;

  resolveExternalRef(sub: string): Promise<ExternalRef> {
    // There is no external IdP in local mode; a local user has no `externalId`. Callers never reach this
    // (the guard's handleLocal resolves users by our own session token, not an OIDC `sub`), but keep it
    // honest: echo the argument as the "ref" with no side effect.
    return Promise.resolve({ externalId: sub });
  }

  createUser(input: CreateIdentityUserInput): Promise<ExternalRef> {
    // No IdP to create a user in. lazyit's local row (with its own passwordHash) IS the account — nothing
    // is mirrored. Return the empty ref (no external id); the local create path never persists it.
    this.warnNoOp('createUser', { email: input.email });
    return Promise.resolve({ externalId: '' });
  }

  deactivateUser(externalId: string): Promise<void> {
    this.warnNoOp('deactivateUser', { externalId });
    return Promise.resolve();
  }

  grantRole(externalId: string, role: Role): Promise<void> {
    this.warnNoOp('grantRole', { externalId, role });
    return Promise.resolve();
  }

  revokeRole(externalId: string, role: Role): Promise<void> {
    this.warnNoOp('revokeRole', { externalId, role });
    return Promise.resolve();
  }

  updateUser(
    externalId: string,
    input: UpdateIdentityUserInput,
  ): Promise<void> {
    this.warnNoOp('updateUser', { externalId, fields: Object.keys(input) });
    return Promise.resolve();
  }

  requestPasswordReset(externalId: string): Promise<void> {
    // Defensive only: the Users service's local branch handles reset ENTIRELY (mint a local temp-password)
    // and never calls the provider here. If somehow reached, reject honestly rather than pretend — but the
    // local-mode reset never routes through the IdP seam.
    this.warnNoOp('requestPasswordReset', { externalId });
    return Promise.reject(
      new PasswordResetUnsupportedError(
        'Local mode resets credentials directly, not through an identity provider.',
      ),
    );
  }

  /** Structured debug line for the inert local no-op (ADR-0086 §5). */
  private warnNoOp(operation: string, context: Record<string, unknown>): void {
    this.logger.debug(
      `AUTH_MODE=local: no IdP mirror; skipping ${operation} (lazyit owns local credentials). ${JSON.stringify(
        context,
      )}`,
    );
  }
}
