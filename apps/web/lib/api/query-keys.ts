/**
 * Builds the standard TanStack query-key factory for a resource. Centralizing
 * the shape means the read hooks and the mutations that invalidate them can't
 * drift:
 *
 * - `all`        → `[name]`               — root/prefix for the whole resource
 * - `lists()`    → `[name, "list"]`       — the list query
 * - `detail(id)` → `[name, "detail", id]` — a single record
 *
 * Mutations invalidate `all`; being the common prefix, it refetches both lists
 * and details. The `const` type param keeps `name` a string literal, so keys
 * stay precisely typed (e.g. `readonly ["locations", "list"]`). See ADR-0020.
 */
export function createQueryKeys<const TName extends string>(name: TName) {
  const all = [name] as const;
  return {
    all,
    lists: () => [...all, "list"] as const,
    detail: (id: string) => [...all, "detail", id] as const,
  };
}
