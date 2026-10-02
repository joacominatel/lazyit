import { MONEY_MAX } from '@lazyit/shared';
import {
  deriveLine,
  derivePurchaseReceipt,
  lineTotalToWire,
  purchaseTotals,
  type LineInput,
} from './purchase-order-derived';

const assetLine = (over: Partial<LineInput> = {}): LineInput => ({
  kind: 'ASSET',
  quantity: 4,
  cancelledQuantity: 0,
  unitPrice: null,
  ...over,
});

/** A line with its derived values, as the purchase receipt consumes it. */
const derived = (line: LineInput, received: number) => ({
  ...line,
  ...deriveLine(line, received),
});

describe('deriveLine (ADR-0099 §3, §4)', () => {
  it('NONE with nothing received, everything pending', () => {
    expect(deriveLine(assetLine(), 0)).toMatchObject({
      receivedQuantity: 0,
      pendingQuantity: 4,
      receiptState: 'NONE',
    });
  });

  it('PARTIAL when some units arrived ("3 of 4")', () => {
    expect(deriveLine(assetLine(), 3)).toMatchObject({
      pendingQuantity: 1,
      receiptState: 'PARTIAL',
    });
  });

  it('RECEIVED when received + cancelled reaches the quantity', () => {
    expect(deriveLine(assetLine(), 4).receiptState).toBe('RECEIVED');
    expect(deriveLine(assetLine({ cancelledQuantity: 1 }), 3)).toMatchObject({
      pendingQuantity: 0,
      receiptState: 'RECEIVED',
    });
  });

  it('OVER when more assets point at the line than it expects — surfaced, never clamped', () => {
    expect(deriveLine(assetLine(), 5)).toMatchObject({
      receivedQuantity: 5,
      pendingQuantity: 0,
      receiptState: 'OVER',
    });
    // Cancelled units lower what is expected: 4 ordered, 1 cancelled, 4 arrived is one too many.
    expect(
      deriveLine(assetLine({ cancelledQuantity: 1 }), 4).receiptState,
    ).toBe('OVER');
  });

  it('an OTHER line (or a kind this build does not know) is never pending and has no state', () => {
    for (const kind of ['OTHER', 'LEASE']) {
      expect(deriveLine(assetLine({ kind }), 0)).toMatchObject({
        countable: false,
        pendingQuantity: 0,
        receiptState: null,
      });
    }
  });

  it('a LICENSE line counts its applied seats like received units (#1477)', () => {
    expect(
      deriveLine(assetLine({ kind: 'LICENSE', quantity: 10 }), 4),
    ).toMatchObject({
      countable: true,
      pendingQuantity: 6,
      receiptState: 'PARTIAL',
    });
    expect(
      deriveLine(assetLine({ kind: 'LICENSE', quantity: 10 }), 12).receiptState,
    ).toBe('OVER');
  });

  it('line total = quantity × unit price, exactly, even past int4; unknown price → null', () => {
    expect(
      deriveLine(assetLine({ unitPrice: BigInt(3_000_000_000) }), 0).lineTotal,
    ).toBe(BigInt(12_000_000_000));
    expect(deriveLine(assetLine({ unitPrice: BigInt(0) }), 0).lineTotal).toBe(
      BigInt(0),
    );
    expect(deriveLine(assetLine(), 0).lineTotal).toBeNull();
    expect(lineTotalToWire(BigInt(MONEY_MAX) + BigInt(1))).toBeNull();
    expect(lineTotalToWire(BigInt(12_000_000_000))).toBe(12_000_000_000);
  });
});

describe('derivePurchaseReceipt', () => {
  it('null when the purchase has no countable line', () => {
    expect(
      derivePurchaseReceipt([derived(assetLine({ kind: 'OTHER' }), 0)]),
    ).toBeNull();
  });

  it('sums the countable lines and ignores OTHER lines', () => {
    expect(
      derivePurchaseReceipt([
        derived(assetLine(), 2),
        derived(assetLine({ quantity: 2, cancelledQuantity: 1 }), 0),
        derived(assetLine({ kind: 'OTHER', quantity: 9 }), 0),
      ]),
    ).toEqual({
      state: 'PARTIAL',
      ordered: 6,
      received: 2,
      cancelled: 1,
      pending: 3,
    });
  });

  it('NONE, RECEIVED and OVER at the purchase level', () => {
    expect(derivePurchaseReceipt([derived(assetLine(), 0)])?.state).toBe(
      'NONE',
    );
    expect(derivePurchaseReceipt([derived(assetLine(), 4)])?.state).toBe(
      'RECEIVED',
    );
    expect(
      derivePurchaseReceipt([
        derived(assetLine(), 5),
        derived(assetLine({ quantity: 1 }), 1),
      ])?.state,
    ).toBe('OVER');
    // An over-received line next to a pending one leaves the purchase PARTIAL.
    expect(
      derivePurchaseReceipt([
        derived(assetLine(), 5),
        derived(assetLine({ quantity: 1 }), 0),
      ])?.state,
    ).toBe('PARTIAL');
  });
});

describe('purchaseTotals (ADR-0099 §5)', () => {
  it('one group in the purchase label, counting unpriced lines', () => {
    const lines = [
      deriveLine(assetLine({ unitPrice: BigInt(100_000) }), 0),
      deriveLine(
        assetLine({ kind: 'OTHER', quantity: 1, unitPrice: BigInt(5_000) }),
        0,
      ),
      deriveLine(assetLine(), 0),
    ];
    expect(purchaseTotals('USD', lines)).toEqual([
      { currency: 'USD', amount: 405_000, unpricedLines: 1 },
    ]);
  });

  it('a purchase with no label totals in the "No currency" group', () => {
    expect(
      purchaseTotals(null, [
        deriveLine(assetLine({ unitPrice: BigInt(1) }), 0),
      ]),
    ).toEqual([{ currency: null, amount: 4, unpricedLines: 0 }]);
  });

  it('no lines → no totals', () => {
    expect(purchaseTotals('ARS', [])).toEqual([]);
  });
});
