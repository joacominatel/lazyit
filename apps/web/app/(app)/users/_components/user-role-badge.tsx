import type { Role } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";

/**
 * Read-only pill for a user's RBAC role (ADR-0040). ADMIN is emphasized (it is the privileged role),
 * MEMBER is neutral, VIEWER is the muted read-only role. Used wherever the role is shown without an
 * inline editor (the list cell for non-admins, history views). Editing is the {@link UserRoleSelect}.
 */
const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

export function UserRoleBadge({ role }: { role: Role }) {
  if (role === "ADMIN") {
    return (
      <Badge className="border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
        {ROLE_LABEL.ADMIN}
      </Badge>
    );
  }
  return (
    <Badge variant={role === "MEMBER" ? "secondary" : "outline"}>
      {ROLE_LABEL[role]}
    </Badge>
  );
}
