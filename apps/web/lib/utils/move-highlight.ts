/**
 * Moves a list's highlighted row with wrap-around; an empty list has no row (-1). Shared by every
 * keyboard-driven list that keeps focus in its input (the AI command palette, smart entry).
 */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
