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

/**
 * How long (ms) a copied secret value is allowed to live in the OS clipboard before a best-effort
 * auto-clear (#607). The on-screen reveal auto-masks at 15s; the clipboard — the more durable, more
 * leak-prone exposure (clipboard managers, the next paste, cross-app sync) — gets a slightly longer
 * window so a deliberate paste still lands, then is wiped. Mirrors the short-lived-plaintext posture.
 */
export const CLIPBOARD_CLEAR_MS = 30_000;

/** Handle returned by {@link copyTextWithAutoClear} so callers can show a hint and cancel on unmount. */
export interface CopyWithAutoClear {
  /** Whether the initial copy succeeded (same contract as {@link copyText}). */
  ok: boolean;
  /** The window after which the clipboard is auto-cleared, in ms (only meaningful when `ok`). */
  clearAfterMs: number;
  /** Cancel the pending auto-clear (e.g. on component unmount). Safe to call multiple times. */
  cancel: () => void;
}

/**
 * copyTextWithAutoClear — copy a secret value, then schedule a BEST-EFFORT clipboard clear (#607).
 *
 * After a successful copy we set a timer for {@link CLIPBOARD_CLEAR_MS}. When it fires we do a
 * COMPARE-THEN-CLEAR: read the clipboard back (`readText`, where the browser permits it) and overwrite
 * it with an empty string ONLY if it still holds the value we copied — so we never clobber something the
 * user has since copied elsewhere. If `readText` is unavailable or rejects (it often requires focus /
 * a permission), we conservatively SKIP the clear rather than risk wiping an unrelated, newer value.
 *
 * This is INHERENTLY best-effort: a clipboard manager may already have captured the value, and the
 * platform can deny clipboard access at any time. It narrows the exposure window; it is not a guarantee.
 *
 * SECURITY (INV-10): the value lives only as a local argument for the compare; it is never logged,
 * stored, cached, or placed in a query key. The compare result is discarded.
 */
export async function copyTextWithAutoClear(text: string): Promise<CopyWithAutoClear> {
  const ok = await copyText(text);
  if (!ok) {
    return { ok: false, clearAfterMs: CLIPBOARD_CLEAR_MS, cancel: () => {} };
  }

  const clipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;

  const timer = setTimeout(async () => {
    // Compare-then-clear. Without a readable clipboard we cannot prove the value is still ours, so we
    // do NOT clear — clobbering a newer, unrelated copy is worse than leaving our own value a moment more.
    try {
      if (!clipboard?.writeText || !clipboard.readText) return;
      const current = await clipboard.readText();
      if (current === text) {
        await clipboard.writeText("");
      }
    } catch {
      // Lost focus / permission denied / unsupported — silently give up. Never surface the value.
    }
  }, CLIPBOARD_CLEAR_MS);

  return {
    ok: true,
    clearAfterMs: CLIPBOARD_CLEAR_MS,
    cancel: () => clearTimeout(timer),
  };
}
