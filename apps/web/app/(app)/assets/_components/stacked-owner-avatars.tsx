import type { AssetAssignmentWithUser } from "@lazyit/shared";
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { UserAvatar } from "@/components/user-avatar";

const MAX_SHOWN = 4;

/**
 * Overlapping avatars of an asset's active owners, with a "+N" overflow chip.
 * Soft-deleted owners (a person who left but whose assignment isn't released yet)
 * render dimmed/grayscale with a "deactivated" hint — they linger until released.
 */
export function StackedOwnerAvatars({
  assignments,
}: {
  assignments: AssetAssignmentWithUser[];
}) {
  if (assignments.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const shown = assignments.slice(0, MAX_SHOWN);
  const extra = assignments.length - shown.length;

  return (
    <AvatarGroup>
      {shown.map(({ id, user }) => {
        const gone = user.deletedAt != null;
        return (
          <UserAvatar
            key={id}
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
    </AvatarGroup>
  );
}
