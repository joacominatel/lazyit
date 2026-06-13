/**
 * copyText — a small, security-conscious clipboard helper for the Secret Manager (SECW-06).
 *
 * The Clipboard API (`navigator.clipboard.writeText`) is ONLY available in a secure context
 * (HTTPS or `localhost`). A self-hosted lazyit reached over plain HTTP — a real deployment shape —
 * exposes no `navigator.clipboard`, so a naive `navigator.clipboard?.writeText(...)` silently
 * no-ops. For most copy buttons that is a minor annoyance; for the RECOVERY KEY it is dangerous:
 * a Copy that quietly does nothing can make the user believe they have saved their ONLY second
 * unlock path when they have not.
 *
 * This helper makes the outcome observable: it returns `true` only when the write actually
 * succeeded, and `false` (never throwing) when the API is unavailable or the write rejected.
 * Callers can then show a "copy failed — select and copy manually" affordance instead of a false
 * success state.
 *
 * SECURITY (INV-10): the value is passed straight to the platform clipboard and is NEVER logged,
 * stored, cached, or placed in a query key. On failure we deliberately surface nothing about the
 * value — only the boolean outcome.
 */
export async function copyText(text: string): Promise<boolean> {
  // Guard the whole chain: `navigator` may be undefined (SSR), `clipboard` is absent in an
  // insecure context, and even when present `writeText` can reject (permissions / focus).
  const clipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    // Permission denied, document not focused, or other platform failure — report failure
    // without leaking anything about the value.
    return false;
  }
}
