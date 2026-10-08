/**
 * The deterministic colour tile of a Knowledge Base folder (#1539). Each folder wears one of the five
 * categorical chart hues — the same palette the avatars and charts use — picked by hashing the
 * folder's id, so a folder keeps its colour in the rail, on its home-page card and in its header, on
 * every screen and for every viewer, with nothing stored. Two folders may share a hue; the tile is a
 * wayfinding aid, never an identifier (the name always sits beside it).
 *
 * The tile is decorative (`aria-hidden`): the hue is a `/15` tint plus the glyph in the full hue,
 * never small text, which keeps it inside the ADR-0049 AA rule for chart hues.
 *
 * Full, non-interpolated class strings so the Tailwind v4 scanner keeps them.
 */
export const FOLDER_TILE_CLASSES = [
  "bg-chart-1/15 text-chart-1",
  "bg-chart-2/15 text-chart-2",
  "bg-chart-3/15 text-chart-3",
  "bg-chart-4/15 text-chart-4",
  "bg-chart-5/15 text-chart-5",
] as const;

/** Stable djb2 hash of `id` → an index into {@link FOLDER_TILE_CLASSES}. Same id, same index. */
export function folderColorIndex(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % FOLDER_TILE_CLASSES.length;
}

/** The tile classes (tint + glyph colour) for the folder `id`. */
export function folderTileClass(id: string): string {
  return FOLDER_TILE_CLASSES[folderColorIndex(id)];
}
