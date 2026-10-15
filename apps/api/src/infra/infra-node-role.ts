import {
  CONTAINER_ID_SEPARATOR,
  GUEST_ID_SEPARATOR,
  type InfraNodeListRole,
} from '@lazyit/shared';
import type { Prisma } from '../../generated/prisma/client';

/** Child identity is namespaced in `externalId`; it is deliberately independent of node `kind`. */
const INFRA_CHILD_IDENTITY_WHERE = {
  OR: [
    { externalId: { contains: CONTAINER_ID_SEPARATOR } },
    { externalId: { contains: GUEST_ID_SEPARATOR } },
  ],
} satisfies Prisma.InfraNodeWhereInput;

export function infraNodeRoleWhere(
  role: InfraNodeListRole,
): Prisma.InfraNodeWhereInput {
  if (role === 'CHILD') return INFRA_CHILD_IDENTITY_WHERE;
  // `NOT (LIKE …)` is NULL for a NULL key, so a manual node needs its own branch to count as a host.
  return {
    OR: [{ externalId: null }, { NOT: INFRA_CHILD_IDENTITY_WHERE }],
  };
}
