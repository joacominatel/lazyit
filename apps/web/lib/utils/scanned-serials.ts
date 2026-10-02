/**
 * Scanning serial numbers into the Receive stock serials box (ADR-0099 Phase 1b, UX proposal §6, #1476) —
 * pure, so the append and de-duplication rules are tested without a camera.
 *
 * The camera reports the same code on every frame it sees it, so a scan session de-duplicates twice: a
 * repeat of the code just read is ignored silently (the box is still in front of the camera), and a code
 * already in the box is a duplicate the operator is told about.
 */

/** The longest serial the receive accepts (the shared receive schemas). */
export const SERIAL_MAX_LENGTH = 200;

/** How long the same code is ignored after it was read, in ms — the camera keeps seeing it. */
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

/** The serials box with one more serial on its own line — what was typed or pasted stays as it is. */
export function appendSerial(serials: string, code: string): string {
  const value = code.trim();
  if (serials.trim() === "") return value;
  return serials.endsWith("\n") ? `${serials}${value}` : `${serials}\n${value}`;
}
