// The P2002 meta Prisma 7.10 + adapter-pg produces, captured from a live duplicate insert: no `target`.
export function adapterPgUniqueViolationMeta(
  constraint: { index: string } | { fields: string[] },
  modelName = 'Asset',
): Record<string, unknown> {
  const driverAdapterError = Object.assign(
    new Error('UniqueConstraintViolation'),
    {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        originalMessage: 'duplicate key value violates unique constraint',
        kind: 'UniqueConstraintViolation',
        constraint,
      },
    },
  );
  return { modelName, driverAdapterError };
}
