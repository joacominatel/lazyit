import { SetMetadata } from '@nestjs/common';

/** Metadata key under which `@Public()` flags a route as not requiring authentication. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or whole controller) as public so the global JwtAuthGuard (ADR-0038) lets it
 * through without authentication. The guard reads this via `Reflector.getAllAndOverride` so a
 * method-level `@Public()` overrides a class-level one.
 *
 * Used by the health endpoints (`/health/live`, `/health/ready`) which must answer to an
 * unauthenticated orchestrator/load balancer probe.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
