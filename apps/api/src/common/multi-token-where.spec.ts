import { multiTokenWhere } from './multi-token-where';

const FIELDS = ['firstName', 'lastName', 'email'] as const;
const ci = (token: string) => ({ contains: token, mode: 'insensitive' });

describe('multiTokenWhere', () => {
  it('ANDs a per-token OR so "Nahuel Genari" needs each token in some field (issue #1053)', () => {
    expect(multiTokenWhere('Nahuel Genari', FIELDS)).toEqual({
      AND: [
        {
          OR: [
            { firstName: ci('Nahuel') },
            { lastName: ci('Nahuel') },
            { email: ci('Nahuel') },
          ],
        },
        {
          OR: [
            { firstName: ci('Genari') },
            { lastName: ci('Genari') },
            { email: ci('Genari') },
          ],
        },
      ],
    });
  });

  it('degrades to a single OR for a one-word query (unchanged legacy behavior)', () => {
    expect(multiTokenWhere('Nahuel', FIELDS)).toEqual({
      AND: [
        {
          OR: [
            { firstName: ci('Nahuel') },
            { lastName: ci('Nahuel') },
            { email: ci('Nahuel') },
          ],
        },
      ],
    });
  });

  it('is case-insensitive on every field (mode: insensitive on each clause)', () => {
    const where = multiTokenWhere('AB', FIELDS) as {
      AND: Array<{ OR: Array<Record<string, { mode: string }>> }>;
    };
    for (const clause of where.AND[0].OR) {
      const only = Object.values(clause)[0];
      expect(only.mode).toBe('insensitive');
    }
  });

  it('collapses repeated / surrounding whitespace between tokens', () => {
    const where = multiTokenWhere('  Nahuel   Genari  ', FIELDS) as {
      AND: unknown[];
    };
    expect(where.AND).toHaveLength(2);
  });

  it('returns no filter ({}) for an empty, whitespace-only, or undefined query', () => {
    expect(multiTokenWhere('', FIELDS)).toEqual({});
    expect(multiTokenWhere('   ', FIELDS)).toEqual({});
    expect(multiTokenWhere(undefined, FIELDS)).toEqual({});
  });
});
