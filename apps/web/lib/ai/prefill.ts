/**
 * A message an entry point prepared for the composer ("Ask AI to fill", #1478). It never replaces what the
 * person already typed: the prepared message comes first and their draft follows, so nothing is lost.
 * Bounded to `max` (the prompt limit). Pure.
 */
export function composerTextWithPrefill(prefill: string, draft: string, max: number): string {
  const kept = draft.trim();
  const text = kept === "" ? prefill : `${prefill}\n\n${kept}`;
  return text.slice(0, max);
}
