import type { Prisma } from '../../generated/prisma/client';

// adapter-pg never sets meta.target: the violated index arrives in meta.driverAdapterError.cause.constraint.
export function uniqueViolationTargets(
  err: Prisma.PrismaClientKnownRequestError,
): string[] {
  const meta = err.meta;
  const names: unknown[] = [];

  const target = meta?.target;
  if (Array.isArray(target)) names.push(...(target as unknown[]));
  else names.push(target);

  const adapterError = meta?.driverAdapterError as
    | { cause?: { constraint?: { index?: unknown; fields?: unknown } } }
    | undefined;
  const constraint = adapterError?.cause?.constraint;
  names.push(constraint?.index);
  if (Array.isArray(constraint?.fields)) {
    names.push(...(constraint.fields as unknown[]));
  }

  return names.filter((n): n is string => typeof n === 'string');
}
