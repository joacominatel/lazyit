/**
 * Canonical categorical / avatar palette.
 *
 * The single source of truth for "a stable color per person/entity". The palette is the five
 * categorical hues from the chart ramp (indigo / teal / green / amber / rose), realized via the
 * `--avatar-1..5` tokens at a lightness that clears white-text WCAG AA on both themes — so the
 * same identity colors drive charts and initials chips, and the same seed always maps to the same
 * color across every screen (Users, asset owners, access grantees, the activity feed, …).
 *
 * Full, non-interpolated class strings so the Tailwind v4 scanner keeps them.
 */
export const AVATAR_PALETTE = [
  "bg-avatar-1 text-avatar-foreground",
  "bg-avatar-2 text-avatar-foreground",
  "bg-avatar-3 text-avatar-foreground",
  "bg-avatar-4 text-avatar-foreground",
  "bg-avatar-5 text-avatar-foreground",
] as const;

/**
 * Stable string hash (djb2) → palette class string. Same seed ⇒ same color, everywhere.
 * Pass a stable seed (an email or entity id), not a display name.
 */
export function avatarColorFor(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}
