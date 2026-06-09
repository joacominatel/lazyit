import { seedCategoriesOnce } from './seed-categories';

/**
 * Regression for #321: the category seed must be rename-safe. The old per-name seed re-created a
 * renamed category (`Adapters` → `Adaptadores`) on the next `db seed`, duplicating it. `seedCategoriesOnce`
 * seeds only when the table is empty, so a populated table (renamed rows included) is left untouched.
 */
describe('seedCategoriesOnce (#321 rename-safe seed)', () => {
  type Row = { name: string; order?: number };

  function delegate(initialCount: number) {
    return {
      count: jest.fn<Promise<number>, []>().mockResolvedValue(initialCount),
      createMany: jest
        .fn<Promise<{ count: number }>, [{ data: Row[] }]>()
        .mockImplementation(({ data }) =>
          Promise.resolve({ count: data.length }),
        ),
    };
  }

  it('seeds the reference set when the table is empty', async () => {
    const d = delegate(0);
    const rows: Row[] = [
      { name: 'Cables', order: 1 },
      { name: 'Adapters', order: 2 },
    ];

    const created = await seedCategoriesOnce(d, rows);

    expect(created).toBe(2);
    expect(d.createMany).toHaveBeenCalledWith({ data: rows });
  });

  it('does NOT re-create rows when the table already has any row (renamed category is not duplicated)', async () => {
    // Table holds a single (renamed) row — e.g. the user renamed `Adapters` to `Adaptadores`.
    const d = delegate(1);

    const created = await seedCategoriesOnce(d, [
      { name: 'Cables', order: 1 },
      { name: 'Adapters', order: 2 }, // would be the duplicate under the old per-name seed
    ]);

    expect(created).toBe(0);
    expect(d.createMany).not.toHaveBeenCalled();
  });

  it('treats a populated table as seeded regardless of how many rows it holds', async () => {
    const d = delegate(5);

    const created = await seedCategoriesOnce(d, [{ name: 'Other' }]);

    expect(created).toBe(0);
    expect(d.createMany).not.toHaveBeenCalled();
  });
});
