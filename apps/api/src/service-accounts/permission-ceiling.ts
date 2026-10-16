import { ForbiddenException } from '@nestjs/common';
import type { Permission } from '@lazyit/shared';

// SEC-088: a human hands a service account only verbs their own role holds.
export function assertWithinPermissionCeiling(
  held: ReadonlySet<Permission>,
  verbs: readonly Permission[],
): void {
  const exceeded = verbs.filter((p) => !held.has(p));
  if (exceeded.length === 0) return;
  throw new ForbiddenException({
    statusCode: 403,
    code: 'PERMISSION_CEILING_EXCEEDED',
    message: 'A service account can only hold permissions your own role holds.',
    permissions: exceeded,
  });
}
