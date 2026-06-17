import { LIKE_ESCAPE_CHAR, escapeLikePattern } from './escape-like-pattern';

describe('escapeLikePattern', () => {
  it('escapes the % wildcard so it matches a literal percent', () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
  });

  it('escapes the _ single-char wildcard so it matches a literal underscore', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes the escape char itself (and does not double-escape its own output)', () => {
    // A single backslash becomes an escaped backslash — not two passes of escaping.
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    // A user-typed `\%` must stay two literal chars: `\\` then `\%`.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('escapes every metachar in a mixed string in one pass', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('leaves a string with no metacharacters untouched', () => {
    expect(escapeLikePattern('laptop-01')).toBe('laptop-01');
    expect(escapeLikePattern('')).toBe('');
  });

  it('exposes the escape char the SQL ESCAPE clause must use', () => {
    expect(LIKE_ESCAPE_CHAR).toBe('\\');
  });
});
