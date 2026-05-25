import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Deterministic initials avatar for a person. The User model has no image yet,
 * so it always renders a colored fallback whose color is derived from a stable
 * seed (the email) — the same person keeps the same color everywhere.
 *
 * Lives in components/ (not a feature `_components/` folder) on purpose: it will
 * be reused well beyond the Users screen — asset assignments, ticket
 * requesters/assignees, access grants, etc. This is the documented exception to
 * the "promote on the second reuse" rule (ADR-0020).
 */

// Solid, white-on-color chips. Full class strings (never interpolated) so the
// Tailwind v4 scanner keeps them. Chosen to read in both light and dark themes.
const PALETTE = [
  "bg-rose-600 text-white",
  "bg-orange-600 text-white",
  "bg-amber-600 text-white",
  "bg-emerald-600 text-white",
  "bg-teal-600 text-white",
  "bg-sky-600 text-white",
  "bg-blue-600 text-white",
  "bg-indigo-600 text-white",
  "bg-violet-600 text-white",
  "bg-fuchsia-600 text-white",
] as const;

/** Stable string hash (djb2) → palette index. Same seed ⇒ same color. */
function colorFor(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** "Ada" + "Lovelace" → "AL"; falls back to the email's first letter. */
function initialsFor(
  firstName?: string | null,
  lastName?: string | null,
  email?: string,
): string {
  const first = firstName?.trim()?.[0] ?? "";
  const last = lastName?.trim()?.[0] ?? "";
  const initials = `${first}${last}`.toUpperCase();
  if (initials) return initials;
  return (email?.trim()?.[0] ?? "?").toUpperCase();
}

interface UserAvatarProps {
  firstName?: string | null;
  lastName?: string | null;
  /** Used both for the initials fallback and as the color seed. */
  email: string;
  size?: "sm" | "default" | "lg";
  className?: string;
  /** Native tooltip text (e.g. the person's name) shown on hover. */
  title?: string;
}

export function UserAvatar({
  firstName,
  lastName,
  email,
  size = "default",
  className,
  title,
}: UserAvatarProps) {
  return (
    <Avatar size={size} className={className} title={title}>
      <AvatarFallback className={cn("font-medium", colorFor(email))}>
        {initialsFor(firstName, lastName, email)}
      </AvatarFallback>
    </Avatar>
  );
}
