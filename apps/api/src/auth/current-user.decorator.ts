import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRow } from '../prisma/prisma-omit';

/**
 * Parameter decorator that extracts the authenticated User from the request. The row carries no
 * `passwordHash` (ADR-0105 global omit).
 * Populated by JwtAuthGuard (ADR-0038):
 *   - OIDC mode: always a valid User entity (guard throws 401 otherwise).
 *   - Shim mode: the resolved User or undefined (anonymous).
 *
 * Usage:
 *   @Get()
 *   findAll(@CurrentUser() user?: User) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UserRow | undefined =>
    ctx.switchToHttp().getRequest<{ user?: UserRow }>().user,
);
