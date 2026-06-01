import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Role } from '../../../generated/prisma/client';
import type {
  CreateIdentityUserInput,
  ExternalRef,
  IdentityProvider,
} from './identity-provider.interface';

/**
 * ZitadelIdentityProvider — STUB (ADR-0043, Phase 1).
 *
 * Zitadel is lazyit's recommended self-hosted IdP, and the only one we can MANAGE (provision users,
 * disable them, mirror role grants) via its Management API. Phase 2 fills these methods with real
 * Management-API calls (PAT for bootstrap, Private-Key JWT for runtime — ADR-0043 decision #4).
 *
 * Phase 1 is scaffolding only: the management methods are not wired into any guard/service yet, so
 * they throw {@link NotImplementedException} with a TODO(Phase 2) note (a loud failure if something
 * calls them prematurely, vs. the generic provider's intentional silent no-op). `resolveExternalRef`
 * is already functional and returns `{ externalId: sub }` — the `sub` is the external reference lazyit
 * persists; Phase 2 may enrich it if the managed Zitadel user id differs from the token sub.
 *
 * Authorization stays DB-first regardless (ADR-0043 decision #1): even once these write-backs exist,
 * they MIRROR lazyit's decisions into Zitadel — the RolesGuard never reads a role from the token.
 */
@Injectable()
export class ZitadelIdentityProvider implements IdentityProvider {
  readonly kind = 'zitadel';
  readonly supportsManagement = true;

  resolveExternalRef(sub: string): Promise<ExternalRef> {
    // Phase 1: the OIDC `sub` IS the external reference. Phase 2 may resolve a distinct Zitadel user id.
    return Promise.resolve({ externalId: sub });
  }

  // The management methods are unimplemented in Phase 1. They return a REJECTED promise (consistent
  // with the Promise-returning contract — a Phase-2 caller can `await`/`.catch()` it uniformly) rather
  // than throwing synchronously. The TODO markers below are where Phase 2 plugs in the real
  // Management-API calls (PAT for bootstrap, Private-Key JWT for runtime — ADR-0043 decision #4).

  // TODO(Phase 2): call the Zitadel Management API to create/import the user and return its id.
  createUser(input: CreateIdentityUserInput): Promise<ExternalRef> {
    return this.notImplemented('createUser', input.email);
  }

  // TODO(Phase 2): call the Zitadel Management API to deactivate the user.
  deactivateUser(externalId: string): Promise<never> {
    return this.notImplemented('deactivateUser', externalId);
  }

  // TODO(Phase 2): mirror the role grant via the Zitadel Management API (project role assignment).
  grantRole(externalId: string, role: Role): Promise<never> {
    return this.notImplemented('grantRole', `${externalId}:${role}`);
  }

  // TODO(Phase 2): mirror the role revocation via the Zitadel Management API.
  revokeRole(externalId: string, role: Role): Promise<never> {
    return this.notImplemented('revokeRole', `${externalId}:${role}`);
  }

  /**
   * Build the Phase-1 not-yet-implemented rejection shared by all management methods. `context` is
   * folded into the message purely so the (otherwise-unused) Phase-1 params are referenced — Phase 2
   * replaces each call site with a real Management-API request.
   */
  private notImplemented(operation: string, context: string): Promise<never> {
    return Promise.reject(
      new NotImplementedException(
        `ZitadelIdentityProvider.${operation} is not implemented yet (ADR-0043 Phase 2) [${context}]`,
      ),
    );
  }
}
