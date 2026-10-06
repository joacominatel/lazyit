import {
  applicationMoneyToDb,
  applicationMoneyToWire,
  assetMoneyToDb,
  assetMoneyToWire,
} from './money';

describe('money boundary (ADR-0100)', () => {
  it('reads: converts the bigint money columns to numbers and leaves everything else alone', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const row = {
      id: 'a1',
      purchaseCost: BigInt(3_000_000_000),
      salvageValue: null,
      usefulLifeMonths: 36,
      createdAt,
    };

    const wire = assetMoneyToWire(row);

    expect(wire).toEqual({
      id: 'a1',
      purchaseCost: 3_000_000_000,
      salvageValue: null,
      usefulLifeMonths: 36,
      createdAt,
    });
    expect(JSON.parse(JSON.stringify(wire))).toMatchObject({
      purchaseCost: 3_000_000_000,
    });
    expect(row.purchaseCost).toBe(BigInt(3_000_000_000)); // the input is not mutated
    expect(
      applicationMoneyToWire({ id: 'p1', costPerSeat: BigInt(1_299) }),
    ).toEqual({ id: 'p1', costPerSeat: 1_299 });
  });

  it('writes: converts present amounts to bigint; absent and null pass through', () => {
    expect(
      assetMoneyToDb({
        name: 'x',
        purchaseCost: 3_000_000_000,
        salvageValue: null,
      }),
    ).toEqual({
      name: 'x',
      purchaseCost: BigInt(3_000_000_000),
      salvageValue: null,
    });
    const absent: { name: string; purchaseCost?: number } = { name: 'x' };
    expect(assetMoneyToDb(absent)).toEqual({ name: 'x' });
    expect(applicationMoneyToDb({ costPerSeat: 0 })).toEqual({
      costPerSeat: BigInt(0),
    });
  });
});
