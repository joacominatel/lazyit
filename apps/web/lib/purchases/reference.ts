/**
 * A repeated reference (ADR-0099 §6): references are not unique, so a purchase of the same supplier that
 * already carries the typed reference is surfaced as a non-blocking hint ("open it?"), never a refusal.
 * Compared trimmed and case-insensitively; the purchase being edited is not its own duplicate.
 */
export function referenceDuplicate<T extends { id: string; reference: string | null }>(
  reference: string,
  purchases: readonly T[],
  selfId?: string,
): T | null {
  const wanted = reference.trim().toLowerCase();
  if (wanted === "") return null;
  return (
    purchases.find(
      (p) => p.id !== selfId && (p.reference ?? "").trim().toLowerCase() === wanted,
    ) ?? null
  );
}
