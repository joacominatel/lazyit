import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { type Principal, isServicePrincipal } from '../auth/principal';

/**
 * Refuses a SERVICE PRINCIPAL outright on every Secret Manager route (403), regardless of its grants.
 *
 * The Secret Manager is HUMAN-ONLY by construction (ADR-0061): a vault is a zero-knowledge crypto
 * boundary whose DEK is wrapped to a per-user X25519 keypair, and a service account has no keypair and
 * is never a crypto member. The "no grant-what-you-can't-read" fence (ADR-0061 §4) and the per-user
 * envelope (§3) have no meaning for a non-human principal — it can hold neither a passphrase nor a
 * recovery key, so it could never decrypt anything it were handed. We therefore close the door at the
 * authorization edge: a bot must never enter the Secret Manager, even if a pre-existing row somehow
 * granted it `secret:read` / `secret:manage` (the INV-SA spirit — mirrors {@link
 * ServicePrincipalForbiddenGuard} for the principal/permission-matrix surfaces).
 *
 * WHY A DEDICATED GUARD (not RolesGuard): the refusal is unconditional on the caller's grants. Folding
 * an entity-kind check into the general permission logic would tangle two concerns; a single-purpose
 * guard keeps both clean.
 *
 * ORDERING: class/method `@UseGuards` decorators run AFTER the global guards in NestJS, so
 * `request.principal` is already populated by the global `JwtAuthGuard` when this runs. Human principals
 * (and the anonymous shim — still gated by `@RequirePermission` in the global RolesGuard) pass through.
 */
@Injectable()
export class HumanOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal }>();
    if (isServicePrincipal(request.principal)) {
      throw new ForbiddenException(
        'Service accounts cannot access the Secret Manager (vaults are human-only).',
      );
    }
    return true;
  }
}
