/**
 * One save at a time. A purchase save is several requests (it may create the supplier first), so a second
 * submit fired before React re-renders — a repeated Ctrl/⌘+Enter, a double click — would create a duplicate
 * supplier and purchase. `lock` is a ref the form owns: a run that finds it held is skipped, and the lock
 * is released when the run settles, even if it throws.
 */
export async function runExclusive(
  lock: { current: boolean },
  task: () => Promise<void>,
): Promise<boolean> {
  if (lock.current) return false;
  lock.current = true;
  try {
    await task();
    return true;
  } finally {
    lock.current = false;
  }
}
