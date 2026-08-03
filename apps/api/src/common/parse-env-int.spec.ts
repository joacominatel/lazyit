import { parseEnvInt } from './parse-env-int';

describe('parseEnvInt', () => {
  it('reads a positive integer', () => {
    expect(parseEnvInt('CAP', 50, { CAP: '7' })).toBe(7);
  });

  it('falls back when unset or blank', () => {
    expect(parseEnvInt('CAP', 50, {})).toBe(50);
    expect(parseEnvInt('CAP', 50, { CAP: '' })).toBe(50);
    expect(parseEnvInt('CAP', 50, { CAP: '   ' })).toBe(50);
  });

  it('falls back on a non-numeric, zero, negative or infinite value (never throws)', () => {
    // A typo in a hand-edited .env must leave the SAFE default in force, not disable the limit and
    // not stop the API from booting.
    expect(parseEnvInt('CAP', 50, { CAP: 'fifty' })).toBe(50);
    expect(parseEnvInt('CAP', 50, { CAP: '0' })).toBe(50);
    expect(parseEnvInt('CAP', 50, { CAP: '-10' })).toBe(50);
    expect(parseEnvInt('CAP', 50, { CAP: 'Infinity' })).toBe(50);
    expect(parseEnvInt('CAP', 50, { CAP: 'NaN' })).toBe(50);
  });

  it('floors a fractional value (a cap is a count)', () => {
    expect(parseEnvInt('CAP', 50, { CAP: '1.9' })).toBe(1);
  });

  it('defaults to process.env when no environment is passed', () => {
    const saved = process.env.LAZYIT_TEST_CAP;
    process.env.LAZYIT_TEST_CAP = '3';
    try {
      expect(parseEnvInt('LAZYIT_TEST_CAP', 50)).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.LAZYIT_TEST_CAP;
      else process.env.LAZYIT_TEST_CAP = saved;
    }
  });
});
