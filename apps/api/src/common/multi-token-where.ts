/** A case-insensitive substring match on one string column — the leaf of every token's OR. */
type Contains = { contains: string; mode: 'insensitive' };

/**
 * Free-text search `where` fragment that matches `q` TOKEN-WISE across several string columns.
 *
 * Split `q` on whitespace and require every token to appear (case-insensitive `contains`) in AT
 * LEAST ONE of `fields` — an AND of per-token ORs. This makes `"Nahuel Genari"` match a row whose
 * `firstName` is `"Nahuel"` and `lastName` is `"Genari"` (issue #1053), which a single whole-term
 * OR cannot: no one column holds the full string. A single token degrades to the plain OR, so
 * existing single-word searches are unchanged and still case-insensitive.
 *
 * A blank / whitespace-only / undefined `q` yields `{}` (no filter), so callers can spread it
 * unconditionally — `{ ...multiTokenWhere(q, [...]), ...otherFilters }` — exactly like the previous
 * inline `...(q ? { OR } : {})`.
 *
 * Returned generically (not a `Prisma.<Model>WhereInput`) so any list service can spread it into its
 * own where; the produced shape is structurally a valid Prisma AND/OR fragment for the given fields.
 */
export function multiTokenWhere<F extends string>(
  q: string | undefined,
  fields: readonly F[],
):
  | { AND: Array<{ OR: Array<Partial<Record<F, Contains>>> }> }
  | Record<never, never> {
  const tokens = (q ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  return {
    AND: tokens.map((token) => ({
      OR: fields.map((field) => ({
        [field]: { contains: token, mode: 'insensitive' as const },
      })) as Array<Partial<Record<F, Contains>>>,
    })),
  };
}
