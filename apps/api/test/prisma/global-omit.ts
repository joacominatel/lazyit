import { PRISMA_GLOBAL_OMIT } from '../../src/prisma/prisma-omit';

type Row = Record<string, unknown>;
type QueryArgs = {
  omit?: Record<string, boolean | undefined>;
  select?: Record<string, unknown>;
};

/**
 * Apply the client-level omit (ADR-0105) to a row an in-memory Prisma fake returns, the way the real
 * client does: a globally omitted column is dropped unless the query opts back in with
 * `omit: { col: false }` or names it in `select`. Fakes that run a module end to end use this so a
 * missed opt-in (login, token verification, decryption) fails the spec instead of passing silently.
 *
 * Test support only — it lives under `test/`, outside the build.
 */
export function applyGlobalOmit<T extends Row | null | undefined>(
  model: string,
  row: T,
  args: QueryArgs = {},
): T {
  const omitted = (PRISMA_GLOBAL_OMIT as Record<string, Row | undefined>)[
    model
  ];
  if (!omitted || !row) return row;
  const out: Row = { ...row };
  for (const col of Object.keys(omitted)) {
    const optedIn = args.select
      ? Boolean(args.select[col])
      : args.omit?.[col] === false;
    if (!optedIn) delete out[col];
  }
  return out as T;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wrap a mocked Prisma client so every model delegate whose model has globally omitted columns answers
 * through {@link applyGlobalOmit}, the interactive `$transaction` callback included. Specs keep
 * configuring the UNDERLYING mocks (`prisma.smtpSettings.findFirst.mockResolvedValue(row)`) and hand the
 * wrapped client to the service under test, so a removed opt-in shows up as a missing column — exactly
 * what PostgreSQL would do. Nested includes are not projected; `prisma-global-omit.db.spec.ts` pins those
 * against the real client.
 */
export function withGlobalOmit<T extends object>(prisma: T): T {
  const omitted = PRISMA_GLOBAL_OMIT as Record<string, unknown>;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === '$transaction' && typeof value === 'function') {
        return (arg: unknown, ...rest: unknown[]) =>
          (value as AnyFn).call(
            target,
            typeof arg === 'function'
              ? (tx: object) => (arg as AnyFn)(withGlobalOmit(tx))
              : arg,
            ...rest,
          );
      }
      if (
        typeof prop !== 'string' ||
        !(prop in omitted) ||
        typeof value !== 'object' ||
        value === null
      ) {
        return value;
      }
      const model = prop;
      return new Proxy(value, {
        get(delegate, method, delegateReceiver) {
          const fn = Reflect.get(delegate, method, delegateReceiver) as unknown;
          if (typeof fn !== 'function') return fn;
          return async (args: QueryArgs = {}, ...rest: unknown[]) => {
            const result = (await (fn as AnyFn).call(
              delegate,
              args,
              ...rest,
            )) as Row | Row[] | null | undefined;
            return Array.isArray(result)
              ? result.map((row) => applyGlobalOmit(model, row, args))
              : applyGlobalOmit(model, result, args);
          };
        },
      });
    },
  });
}
