import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";

/**
 * The amiable "you don't have access" surface for Reports. The screen is gated on the
 * ADMIN-only `logs:read` permission (issue #177); a caller without it sees this calm state rather
 * than a crash or a blank page. v1 NOTE: this is a UI-level gate — the underlying activity feed is
 * still the shared `dashboard:read` stream; a dedicated `logs:read`-gated endpoint is DEBT-1.
 * Reuses the warm EmptyState so the dead-end still feels cared-for.
 */
export function ReportsAccessDenied() {
  const t = useTranslations("reports");
  return (
    <EmptyState
      icon={LockClosedIcon}
      pillar="manage"
      title={t("page.accessDeniedTitle")}
      description={t("page.accessDeniedDescription")}
      action={{ label: t("page.accessDeniedAction"), href: "/dashboard" }}
    />
  );
}
