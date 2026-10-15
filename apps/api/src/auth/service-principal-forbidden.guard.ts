import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { type Principal, isServicePrincipal } from './principal';

// Both service-account guards are reused across many unrelated controllers, so this names no feature.
export const SERVICE_ACCOUNT_FORBIDDEN_MESSAGE =
  'Service accounts cannot use this endpoint; it requires a human user.';

/**
 * Layer-2 runtime backstop for INV-SA-3 (SEC-011, ADR-0048 Fork #3).
 *
 * Refuses a SERVICE PRINCIPAL outright on any route that carries this guard, regardless of its
 * permission grants. This closes the self-escalation / persistence / authz-rewrite attack surface for
 * the principal- and authz-management endpoints:
 *   - `ServiceAccountsController` (every route) — a bot must never manage bots.
 *   - `GET /config/permissions` and `PUT /config/permissions` — a bot must never read or rewrite the
 *     human MEMBER/VIEWER authorization matrix.
 * Many other human-only controllers reuse it, hence the feature-neutral message.
 *
 * WHY A SEPARATE GUARD (not a change to RolesGuard):
 * The refusal is unconditional on the caller's grants — even if a service account somehow holds
 * `settings:manage` (e.g. a pre-existing row granted before Layer 1 closed off new grants), it must
 * still be blocked here. Adding this to `RolesGuard` would tangle a blanket entity-kind check into the
 * general permission logic; a dedicated guard keeps both pieces single-purpose.
 *
 * ORDERING: class/method `@UseGuards` decorators run AFTER global guards in NestJS, so `request.principal`
 * is already set by the global `JwtAuthGuard` when this runs. Human principals pass through unchanged.
 */
@Injectable()
export class ServicePrincipalForbiddenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal }>();
    if (isServicePrincipal(request.principal)) {
      throw new ForbiddenException(SERVICE_ACCOUNT_FORBIDDEN_MESSAGE);
    }
    return true;
  }
}
