import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { type Principal, isServicePrincipal } from '../auth/principal';

/**
 * The INVERSE of {@link HumanOnlyGuard}: refuses a NON-SERVICE principal (a human, or the anonymous shim)
 * outright on the headless secret-fetch route (403), regardless of permissions (ADR-0080).
 *
 * Programmatic secret retrieval is MACHINE-ONLY by construction: the token-derived KEK that unwraps the
 * SA's private key only makes sense for a service account (a human has no `ServiceAccountKeypair`), and the
 * whole point of the endpoint is headless, credential-free-of-a-human automation. Even an ADMIN — who
 * holds `secret:fetch` via the complete catalog — must be refused here: an ADMIN reads secrets through the
 * human browser flow (their own keypair), never this endpoint. Closing the door at the authorization edge
 * keeps the fetch surface unambiguously service-only; the service also re-asserts it
 * (`requireServiceAccountId`) as the belt-and-suspenders backstop.
 *
 * ORDERING: class/method `@UseGuards` decorators run AFTER the global guards, so `request.principal` is
 * already populated by the global `JwtAuthGuard` when this runs. A service principal passes through.
 */
@Injectable()
export class ServiceOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal }>();
    if (!isServicePrincipal(request.principal)) {
      throw new ForbiddenException(
        'This endpoint is for service accounts only (programmatic secret retrieval).',
      );
    }
    return true;
  }
}
