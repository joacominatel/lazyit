import type { User } from "@lazyit/shared";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { UserAvatar } from "@/components/user-avatar";

const MAX_SHOWN = 4;

/**
 * The minimal grantee shape this component renders: identity + an **optional** `deletedAt`. A
 * deactivated (soft-deleted) grantee — someone offboarded while their grant lingers active — renders
 * dimmed/grayscale with a "deactivated" hint in the tooltip, matching the Assets list treatment.
 * `deletedAt` is optional so callers that only have live users (the common case) don't have to widen.
 */
type AvatarUser = Pick<User, "id" | "firstName" | "lastName" | "email"> & {
  deletedAt?: string | null;
};

/**
 * Overlapping avatars of an application's active grantees, with a "+N" overflow chip. Local to the
 * Access screen for now — the Assets screen has its own (assignment-shaped) variant; promote a
 * generic version on the 3rd reuse (ADR-0020).
 *
 * `deactivatedCount` covers grantees whose user row is **soft-deleted** and so missing from the
 * active-users read (`GET /users` excludes soft-deleted): they keep an active grant but have no
 * identity to render. We surface them as a single dimmed placeholder chip ("⊘N") so the avatars
 * still account for the full grant count and the deactivation is visible on the list.
 */
export function StackedUserAvatars({
  users,
  deactivatedCount = 0,
}: {
  users: AvatarUser[];
  deactivatedCount?: number;
}) {
  if (users.length === 0 && deactivatedCount === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const shown = users.slice(0, MAX_SHOWN);
  const extra = users.length - shown.length;

  return (
    <AvatarGroup>
      {shown.map((user) => {
        const gone = user.deletedAt != null;
        return (
          <UserAvatar
            key={user.id}
            size="sm"
            firstName={user.firstName}
            lastName={user.lastName}
            email={user.email}
            title={`${user.firstName} ${user.lastName}${gone ? " · deactivated" : ""}`}
            className={gone ? "opacity-50 grayscale" : undefined}
          />
        );
      })}
      {extra > 0 && <AvatarGroupCount>+{extra}</AvatarGroupCount>}
      {deactivatedCount > 0 && (
        <Avatar
          size="sm"
          className="opacity-50 grayscale"
          title={`${deactivatedCount} deactivated ${
            deactivatedCount === 1 ? "grantee" : "grantees"
          }`}
        >
          <AvatarFallback>⊘{deactivatedCount}</AvatarFallback>
        </Avatar>
      )}
    </AvatarGroup>
  );
}
