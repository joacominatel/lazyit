import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarColorFor } from "@/lib/avatar-color";
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
 *
 * The color comes from the shared {@link avatarColorFor} (the token-driven categorical
 * palette) — the single source of truth, so a person reads the same color here, in the
 * activity feed, and anywhere else avatars appear.
 */

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
      <AvatarFallback className={cn("font-medium", avatarColorFor(email))}>
        {initialsFor(firstName, lastName, email)}
      </AvatarFallback>
    </Avatar>
  );
}
