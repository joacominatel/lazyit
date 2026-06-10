/**
 * Rename-safe, seed-once helper for the initial category reference sets (asset / article /
 * application / consumable). Lives under `src/` (not `prisma/`) so it is importable and unit-testable
 * in isolation — `prisma/seed.ts` runs `main()` on import, which a jest spec must not trigger.
 *
 * The earlier seed created each category by display name (`findFirst({ where: { name } })` then
 * create). That was NOT rename-safe: renaming a seeded category (e.g. `Adapters` → `Adaptadores`)
 * made the next `db seed` miss the old name and RE-CREATE it, duplicating the row (#321). Seeding
 * **once per table** — only when the table is empty — is rename-safe and never clobbers user edits.
 *
 * The seed's raw PrismaClient is NOT wrapped by the soft-delete extension, so `count()` here counts
 * ALL rows (live OR soft-deleted). That is intentional: a user who soft-deleted every seeded category
 * must not have them resurrected on the next boot.
 */

/** The minimal Prisma model-delegate surface this helper needs (count + bulk insert). */
export interface SeedCategoryDelegate<T> {
  count(): Promise<number>;
  createMany(args: { data: T[] }): Promise<{ count: number }>;
}

/**
 * Seed `rows` into `delegate` only when its table is empty. Returns the number of rows created
 * (`0` when the table already had any row, i.e. the seed-once skip). Pure aside from the two delegate
 * calls, so it unit-tests with a mocked delegate.
 */
export async function seedCategoriesOnce<T>(
  delegate: SeedCategoryDelegate<T>,
  rows: T[],
): Promise<number> {
  if ((await delegate.count()) > 0) {
    return 0; // seed-once: the table already holds rows (live or soft-deleted) — leave it untouched.
  }
  const { count } = await delegate.createMany({ data: rows });
  return count;
}
