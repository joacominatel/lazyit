/** The escape character paired with every `ESCAPE` clause that consumes {@link escapeLikePattern}. */
export const LIKE_ESCAPE_CHAR = '\\';

/**
 * Escape the SQL `LIKE`/`ILIKE` metacharacters in user-supplied free text so they match literally.
 *
 * `LIKE`/`ILIKE` treats `%` (any run of chars), `_` (any single char) and the escape char (`\`) as
 * wildcards. When a raw user string is wrapped in `%...%` for a "contains" filter, those chars leak
 * through as wildcards — `q="50%"` matches every row, `q="a_b"` matches `axb`, a trailing `\` can
 * corrupt the pattern (issue #593). This escapes `\`, `%` and `_` (escape char first, so it doesn't
 * double-escape the escapes it just inserted), leaving the result safe to wrap in `%...%`.
 *
 * The caller MUST pair the produced pattern with `ESCAPE '\'` (see {@link LIKE_ESCAPE_CHAR}) on the
 * `LIKE`/`ILIKE` so Postgres reads `\%`/`\_`/`\\` as the literal characters. This is a CORRECTNESS
 * guard, not an injection one — the pattern is still bound as a parameter, never concatenated.
 *
 * @example
 *   escapeLikePattern('50%')  // -> '50\\%'
 *   escapeLikePattern('a_b')  // -> 'a\\_b'
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
