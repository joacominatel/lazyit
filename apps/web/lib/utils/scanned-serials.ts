/**
 * Scanning serial numbers into the Receive stock serials box (ADR-0099 Phase 1b, UX proposal §6, #1476) —
 * pure, so the append and de-duplication rules are tested without a camera.
 *
 * The camera reports the same code on every frame it sees it, so a scan session de-duplicates twice: a code
 * still in view is ignored silently for as long as it stays in view, and a code already in the box is a
 * duplicate the operator is told about — once it comes back after being out of view.
 */

/** The longest serial the receive accepts (the shared receive schemas). */
export const SERIAL_MAX_LENGTH = 200;

/** How long a code must be out of view before reading it again counts as a new read, in ms. */
export const SCAN_REPEAT_MS = 2000;

/** What to do with one read. */
export type ScanDecision = "add" | "duplicate" | "repeat" | "invalid";

/**
 * Decide what one read does: `invalid` when it is blank or longer than a serial can be (a URL QR, say);
 * `repeat` when it is the code read moments ago; `duplicate` when the box already holds it; else `add`.
 */
export function scanDecision(
  text: string,
  {
    existing,
    last,
    now,
  }: {
    /** The serials in the box now, as parsed (trimmed, non-empty). */
    existing: readonly string[];
    /** The previous read of this session and when it happened. */
    last: { code: string; at: number } | null;
    now: number;
  },
): ScanDecision {
  const code = text.trim();
  if (code === "" || code.length > SERIAL_MAX_LENGTH) return "invalid";
  if (last && last.code === code && now - last.at < SCAN_REPEAT_MS) return "repeat";
  return existing.includes(code) ? "duplicate" : "add";
}

/** The last code read and when it was last seen. */
export type LastScan = { code: string; at: number } | null;

/**
 * One read of a scan session: what it does, and the session's new "last seen". Every read of a valid code
 * refreshes when it was last seen — a repeat included — so a code held in view stays silent however long it
 * stays there, and is reported as a duplicate only after it was out of view for {@link SCAN_REPEAT_MS}.
 */
export function scanStep(
  text: string,
  { existing, last, now }: { existing: readonly string[]; last: LastScan; now: number },
): { decision: ScanDecision; last: LastScan } {
  const decision = scanDecision(text, { existing, last, now });
  return { decision, last: decision === "invalid" ? last : { code: text.trim(), at: now } };
}

/** The serials box with one more serial on its own line — what was typed or pasted stays as it is. */
export function appendSerial(serials: string, code: string): string {
  const value = code.trim();
  if (serials.trim() === "") return value;
  return serials.endsWith("\n") ? `${serials}${value}` : `${serials}\n${value}`;
}
