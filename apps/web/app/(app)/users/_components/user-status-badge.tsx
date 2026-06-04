import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-badge";

/**
 * Active / Inactive pill with a status dot. `isActive` is independent of soft
 * delete: an inactive user is offboarded/disabled but still retained (see the
 * User entity note). Soft-deleted users never reach the list at all.
 *
 * Kept on the neutral Badge (secondary/outline) with a token-driven {@link StatusDot}
 * so the color cue (success / neutral) comes from the single status source, not a
 * hardcoded emerald.
 */
export function UserStatusBadge({ isActive }: { isActive: boolean }) {
  const t = useTranslations("users.status");
  return (
    <Badge variant={isActive ? "secondary" : "outline"} className="gap-1.5">
      <StatusDot tone={isActive ? "success" : "neutral"} />
      {isActive ? t("active") : t("inactive")}
    </Badge>
  );
}
