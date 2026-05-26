import type { User } from "@lazyit/shared";
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { UserAvatar } from "@/components/user-avatar";

const MAX_SHOWN = 4;

type AvatarUser = Pick<User, "id" | "firstName" | "lastName" | "email">;

/**
 * Overlapping avatars of an application's active grantees, with a "+N" overflow chip. Local to the
 * Access screen for now — the Assets screen has its own (assignment-shaped) variant; promote a
 * generic version on the 3rd reuse (ADR-0020).
 */
export function StackedUserAvatars({ users }: { users: AvatarUser[] }) {
  if (users.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const shown = users.slice(0, MAX_SHOWN);
  const extra = users.length - shown.length;

  return (
    <AvatarGroup>
      {shown.map((user) => (
        <UserAvatar
          key={user.id}
          size="sm"
          firstName={user.firstName}
          lastName={user.lastName}
          email={user.email}
          title={`${user.firstName} ${user.lastName}`}
        />
      ))}
      {extra > 0 && <AvatarGroupCount>+{extra}</AvatarGroupCount>}
    </AvatarGroup>
  );
}
