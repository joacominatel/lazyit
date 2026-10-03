/**
 * One save at a time. A purchase save is several requests (it may create the supplier first), so a second
 * submit fired before React re-renders — a repeated Ctrl/⌘+Enter, a double click — would create a duplicate
 * supplier and purchase. `lock` is a ref the form owns: a run that finds it held is skipped, and the lock
 * is released when the run settles, even if it throws — unless the run returns `"hold"`: a save that
 * succeeded and is navigating away keeps the lock, so a submit in the moment before the page changes cannot
 * create the purchase a second time.
 */
export async function runExclusive(
  lock: { current: boolean },
  task: () => Promise<void | "hold">,
): Promise<boolean> {
  if (lock.current) return false;
  lock.current = true;
  let hold = false;
  try {
    hold = (await task()) === "hold";
    return true;
  } finally {
    if (!hold) lock.current = false;
  }
}
