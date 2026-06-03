import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from './principal';

/**
 * Parameter decorator that extracts the unified PRINCIPAL from the request (ADR-0048). Populated by
 * {@link JwtAuthGuard}:
 *   - a HUMAN  → `{ kind: 'human', user }`
 *   - a SERVICE ACCOUNT → `{ kind: 'service', serviceAccount, permissions }`
 *   - anonymous (shim, no resolved user) → undefined
 *
 * Use this when a handler/service must work for BOTH kinds of caller — most importantly to attribute an
 * audited action to the right actor via `ActorService.resolve(principal)`. Handlers that are inherently
 * human-only can keep using `@CurrentUser()`.
 *
 * Usage:
 *   @Post()
 *   create(@Body() dto: CreateAssetDto, @CurrentPrincipal() principal?: Principal) { ... }
 */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal,
);
