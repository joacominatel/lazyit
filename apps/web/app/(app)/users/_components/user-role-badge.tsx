import type { Role } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";

/**
 * Read-only pill for a user's RBAC role (ADR-0040). ADMIN is emphasized (it is the privileged role)
 * via the `info` status tone — the shared, token-driven "noteworthy" color, replacing the former
 * hardcoded off-brand indigo; MEMBER is neutral, VIEWER is the muted read-only role. Used wherever
 * the role is shown without an inline editor (the list cell for non-admins, history views). Editing
 * is the {@link UserRoleSelect}.
 */
export function UserRoleBadge({ role }: { role: Role }) {
  const t = useTranslations("users.role.labels");
  if (role === "ADMIN") {
    return <StatusBadge tone="info">{t("ADMIN")}</StatusBadge>;
  }
  return (
    <Badge variant={role === "MEMBER" ? "secondary" : "outline"}>
      {t(role)}
    </Badge>
  );
}
