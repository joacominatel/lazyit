import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';

/**
 * Parameter decorator that extracts the authenticated User from the request.
 * Populated by JwtAuthGuard (ADR-0038):
 *   - OIDC mode: always a valid User entity (guard throws 401 otherwise).
 *   - Shim mode: the resolved User or undefined (anonymous).
 *
 * Usage:
 *   @Get()
 *   findAll(@CurrentUser() user?: User) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): User | undefined =>
    ctx.switchToHttp().getRequest<{ user?: User }>().user,
);
