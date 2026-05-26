import { useEffect, useState } from "react";

/**
 * Debounce a value: returns `value` only after it has stopped changing for `delayMs`. Keeps a
 * search input from firing a `?q=` request on every keystroke — read the immediate value for the
 * controlled input, the debounced one for the query.
 *
 * Extracted from the KB and Assets list pages once the global search added a third consumer
 * (ADR-0020: generalize on the 3rd genuine reuse).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
