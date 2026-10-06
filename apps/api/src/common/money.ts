/**
 * The API boundary for money (ADR-0100 §3). Money columns are Prisma `BigInt`, which the client returns as
 * a JS `bigint` — and `JSON.stringify` throws on a `bigint`. The wire contract keeps money a JSON `number`
 * bounded to `MONEY_MAX` (`money()` in @lazyit/shared), so:
 *
 * - every service that returns an Asset, Application or PurchaseOrderLine row passes it through
 *   {@link assetMoneyToWire} / {@link applicationMoneyToWire} / {@link purchaseOrderLineMoneyToWire} before
 *   it leaves the service (REST, and through the controllers the AI tools and MCP dispatch to);
 * - every write passes the validated body through {@link assetMoneyToDb} / {@link applicationMoneyToDb} /
 *   {@link purchaseOrderLineMoneyToDb}.
 *
 * There is deliberately NO global `BigInt.prototype.toJSON` patch: a missed conversion must fail loudly
 * in a test, not serialize silently as a string. Every other module reads these tables through a narrow
 * `select` that never includes a money column, or a whole-row read consumed only by the search projectors
 * (`projectAsset` / `projectApplication`), which copy no money field — so the asset and application
 * services, plus the purchase-orders service for line prices (ADR-0099), are the only paths that put money
 * on the wire.
 */

/** The Asset columns that hold money. */
const ASSET_MONEY_FIELDS = ['purchaseCost', 'salvageValue'] as const;
/** The Application columns that hold money. */
const APPLICATION_MONEY_FIELDS = ['costPerSeat'] as const;
/** The PurchaseOrderLine columns that hold money (ADR-0099). */
const PURCHASE_ORDER_LINE_MONEY_FIELDS = ['unitPrice'] as const;

/** `T` with its money keys `K` as wire numbers instead of `bigint`. */
type MoneyOnWire<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: Exclude<T[P], bigint> | number;
};

/** `T` with its money keys `K` as `bigint` for Prisma instead of `number`. */
type MoneyForDb<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: Exclude<T[P], number> | bigint;
};

/**
 * Copy `row`, converting each of `keys` whose value is of type `from`; every other value — `null`, an
 * absent key, an already-converted value — passes through untouched. `Number(bigint)` is exact for every
 * amount the API can write (≤ `MONEY_MAX`, the zod bound).
 */
function convertKeys<T extends object, K extends keyof T>(
  row: T,
  keys: readonly K[],
  from: 'bigint' | 'number',
  convert: (value: never) => unknown,
): T {
  const out = { ...row };
  for (const key of keys) {
    if (typeof out[key] === from) {
      out[key] = convert(out[key] as never) as T[K];
    }
  }
  return out;
}

/** An Asset row (full or partial) with `purchaseCost` / `salvageValue` as wire numbers. */
export function assetMoneyToWire<
  T extends { purchaseCost: bigint | null; salvageValue: bigint | null },
>(row: T): MoneyOnWire<T, 'purchaseCost' | 'salvageValue'> {
  return convertKeys(row, ASSET_MONEY_FIELDS, 'bigint', Number) as never;
}

/** An Application row with `costPerSeat` as a wire number. */
export function applicationMoneyToWire<
  T extends { costPerSeat: bigint | null },
>(row: T): MoneyOnWire<T, 'costPerSeat'> {
  return convertKeys(row, APPLICATION_MONEY_FIELDS, 'bigint', Number) as never;
}

/** A validated Asset write body with its money amounts as `bigint`; absent and `null` pass through. */
export function assetMoneyToDb<
  T extends { purchaseCost?: number | null; salvageValue?: number | null },
>(data: T): MoneyForDb<T, 'purchaseCost' | 'salvageValue'> {
  return convertKeys(data, ASSET_MONEY_FIELDS, 'number', BigInt) as never;
}

/** A validated Application write body with `costPerSeat` as `bigint`; absent and `null` pass through. */
export function applicationMoneyToDb<T extends { costPerSeat?: number | null }>(
  data: T,
): MoneyForDb<T, 'costPerSeat'> {
  return convertKeys(data, APPLICATION_MONEY_FIELDS, 'number', BigInt) as never;
}

/** A PurchaseOrderLine row with `unitPrice` as a wire number (ADR-0099). */
export function purchaseOrderLineMoneyToWire<
  T extends { unitPrice: bigint | null },
>(row: T): MoneyOnWire<T, 'unitPrice'> {
  return convertKeys(
    row,
    PURCHASE_ORDER_LINE_MONEY_FIELDS,
    'bigint',
    Number,
  ) as never;
}

/** A validated line write body with `unitPrice` as `bigint`; absent and `null` pass through. */
export function purchaseOrderLineMoneyToDb<
  T extends { unitPrice?: number | null },
>(data: T): MoneyForDb<T, 'unitPrice'> {
  return convertKeys(
    data,
    PURCHASE_ORDER_LINE_MONEY_FIELDS,
    'number',
    BigInt,
  ) as never;
}
