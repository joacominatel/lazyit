import { parseBooleanQuery } from './parse-boolean-query';

// One helper for every boolean query param; the only difference between callers is the default.
describe('parseBooleanQuery', () => {
  it('returns the default when the param is absent', () => {
    expect(parseBooleanQuery(undefined)).toBe(false);
    expect(parseBooleanQuery(undefined, true)).toBe(true);
  });

  it('treats the documented falsy strings as false (case/space insensitive)', () => {
    for (const v of ['false', 'FALSE', ' false ', '0', 'no', 'off']) {
      expect(parseBooleanQuery(v, true)).toBe(false);
    }
  });

  it('treats anything else (incl. a bare flag) as true', () => {
    expect(parseBooleanQuery('true')).toBe(true);
    expect(parseBooleanQuery('1')).toBe(true);
    expect(parseBooleanQuery('yes')).toBe(true);
    expect(parseBooleanQuery('')).toBe(true); // bare ?flag arrives as ""
  });

  it('parses the SAME string identically regardless of the default (the consistency fix)', () => {
    // Pre-fix, lowStock used `=== "true"` (so "1" was false) while activeOnly used `!== "false"`
    // (so "1" was true). Now "1" is true under both defaults.
    expect(parseBooleanQuery('1', false)).toBe(true);
    expect(parseBooleanQuery('1', true)).toBe(true);
    expect(parseBooleanQuery('false', false)).toBe(false);
    expect(parseBooleanQuery('false', true)).toBe(false);
  });
});
