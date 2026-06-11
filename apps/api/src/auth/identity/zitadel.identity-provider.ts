import { Injectable } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import type { Role } from '../../../generated/prisma/client';
import type {
  CreateIdentityUserInput,
  ExternalRef,
  IdentityProvider,
  UpdateIdentityUserInput,
} from './identity-provider.interface';
import { ZitadelManagementService } from './zitadel-management.service';

/**
 * ZitadelIdentityProvider — the real write-back adapter (ADR-0043 Phase 2).
 *
 * Zitadel is lazyit's recommended self-hosted IdP, and the only one we can MANAGE (provision users,
 * disable them, mirror role grants) via its Management API. This adapter delegates the plumbing
 * (service-account Private-Key JWT auth + token cache + the v2 resource calls) to
 * {@link ZitadelManagementService}; it just maps the {@link IdentityProvider} contract onto it.
 *
 * Authorization stays DB-first regardless (ADR-0043 decision #1): these write-backs MIRROR lazyit's
 * decisions into Zitadel — the RolesGuard never reads a role from the token.
 *
 * Boot / login safety (ADR-0043 §6): the management service reads its config lazily and NEVER throws
 * at construction, so an absent/misconfigured Management credential cannot fail boot. When the
 * credential is missing the management methods throw a clear "Zitadel management not configured"
 * error (surfaced upstream as 503) — the runtime authN path never touches this adapter.
 */
@Injectable()
export class ZitadelIdentityProvider implements IdentityProvider {
  readonly kind = 'zitadel';
  readonly supportsManagement = true;

  // Constructed once. Lazy config resolution lives inside the service, so this is safe at boot even
  // when ZITADEL_MGMT_* are unset (the no-op factory still builds the provider).
  private readonly management: ZitadelManagementService;

  /**
   * `logger` is the request-scoped {@link PinoLogger} the auth module threads in via the factory
   * (issue #219) so the management WARN lines carry the failing edit's `X-Request-Id` / `actor`
   * (ADR-0031). It is optional: the factory / unit tests may `new` this provider with no logger, in
   * which case the management service falls back to the static `@nestjs/common` Logger.
   */
  constructor(logger: PinoLogger | null = null) {
    this.management = new ZitadelManagementService(logger);
  }

  resolveExternalRef(sub: string): Promise<ExternalRef> {
    // The OIDC `sub` IS the Zitadel user id lazyit stores as externalId; no Management call needed.
    return Promise.resolve({ externalId: sub });
  }

  async createUser(input: CreateIdentityUserInput): Promise<ExternalRef> {
    const externalId = await this.management.createUser({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      // Bundled first-run only (issue #335): the wizard-chosen password is set on the Zitadel user so
      // the operator can log in immediately. Undefined in BYOI — lazyit never sets a credential there.
      password: input.password,
    });
    return { externalId };
  }

  deactivateUser(externalId: string): Promise<void> {
    return this.management.deactivateUser(externalId);
  }

  grantRole(externalId: string, role: Role): Promise<void> {
    return this.management.grantRole(externalId, role);
  }

  revokeRole(externalId: string, _role: Role): Promise<void> {
    // The interface carries the role for symmetry/logging, but a revoke clears the user's project
    // grant regardless of which role it held (a role CHANGE is grantRole's revoke-then-grant).
    void _role;
    return this.management.revokeRole(externalId);
  }

  updateUser(
    externalId: string,
    input: UpdateIdentityUserInput,
  ): Promise<void> {
    // Mirror the admin name/email edit onto the existing Zitadel user (issue #149). Same externalId —
    // never a re-link. The management service sets a new email pre-verified (no re-verification).
    return this.management.updateUser(externalId, input);
  }

  requestPasswordReset(externalId: string): Promise<void> {
    // Ask Zitadel to email the reset link via its own SMTP (issue #149). lazyit never sets/sends a
    // password. A missing Management credential surfaces as the usual 503 (assertConfigured upstream).
    return this.management.requestPasswordReset(externalId);
  }
}
