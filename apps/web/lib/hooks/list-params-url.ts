/**
 * Pure URL-patch helpers for {@link useListParams} — the framework-agnostic core of its writer.
 *
 * `useListParams` is a thin React shell over these functions: it reads the current
 * `searchParams`/`pathname` from `next/navigation`, builds a patch with the encoders below, and
 * hands it to {@link buildNextUrl} for a single `router.replace`. Keeping the patch math here (no
 * React, no `next/navigation`) makes the atomicity guarantee — multiple keys applied in ONE write,
 * never last-write-wins — directly unit-testable without a DOM or a router (see
 * `list-params-url.test.ts`); the hook itself stays deferred under ADR-0012.
 */

/** A patch value per key: `undefined`/`""` clears the param, anything else sets it (stringified). */
export type ParamPatch = Record<string, string | number | undefined>;

/**
 * Apply a multi-key `patch` to the current `search` string and return the next URL (path + query).
 *
 * This is the pure core of the hook's `commit`: it starts from the *current* params (so unrelated
 * keys are preserved) and applies every patched key in one pass. Because the whole patch lands in a
 * single `URLSearchParams`, two keys changed together can never clobber each other — the regression
 * fixed in #217 (two sequential `router.replace` calls from one handler, the second re-emitting a
 * stale snapshot) is structurally impossible when callers route both keys through one patch.
 *
 * `undefined` or `""` deletes the key; any other value is set via `String(value)`. When the
 * resulting query is empty the bare `pathname` is returned (no trailing `?`).
 */
export function buildNextUrl(
  search: string,
  pathname: string,
  patch: ParamPatch,
): string {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") {
      next.delete(key);
    } else {
      next.set(key, String(value));
    }
  }
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * One-key patch entry for a **single-value** filter: clears the key when `value` equals the filter's
 * default (the inactive sentinel), otherwise sets it. Mirrors `setFilter`'s default-collapse rule.
 */
export function singleFilterPatch(
  name: string,
  value: string,
  defaults: Record<string, string>,
): ParamPatch {
  const isDefault = value === (defaults[name] ?? "");
  return { [name]: isDefault ? undefined : value };
}

/**
 * One-key patch entry for a **multi-value** filter (#198): clean (trim + drop empties), de-dupe and
 * comma-encode the values into the single param; an empty result (or the default) clears the key.
 * Mirrors `setFilterValues`' encoding so single- and multi-key writes agree byte-for-byte.
 */
export function multiFilterPatch(
  name: string,
  values: string[],
  defaults: Record<string, string>,
): ParamPatch {
  const cleaned = [...new Set(values.map((v) => v.trim()).filter((v) => v !== ""))];
  const encoded = cleaned.join(",");
  const isDefault = encoded === "" || encoded === (defaults[name] ?? "");
  return { [name]: isDefault ? undefined : encoded };
}

/**
 * Build the merged patch for {@link ListParams.setFilters}: apply the single/multi default-collapse
 * rule per key (string ⇒ single, string[] ⇒ multi) into ONE patch, then reset paging (`offset`).
 * The caller commits the whole thing in a single navigation, so every key in `patch` is written
 * atomically — this is what lets a handler change two filters at once without dropping either.
 */
export function buildFiltersPatch(
  patch: Record<string, string | string[]>,
  defaults: Record<string, string>,
): ParamPatch {
  const out: ParamPatch = {};
  for (const [name, value] of Object.entries(patch)) {
    const entry = Array.isArray(value)
      ? multiFilterPatch(name, value, defaults)
      : singleFilterPatch(name, value, defaults);
    Object.assign(out, entry);
  }
  // A filter change is a different result set → back to the first page.
  out.offset = undefined;
  return out;
}
