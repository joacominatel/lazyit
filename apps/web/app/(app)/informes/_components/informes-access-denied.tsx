import { LockClosedIcon } from "@heroicons/react/24/outline";
import { EmptyState } from "@/components/empty-state";

/**
 * The amiable "you don't have access" surface for Reports/Informes. The screen is gated on the
 * ADMIN-only `logs:read` permission (issue #177); a caller without it sees this calm state rather
 * than a crash or a blank page. The API also enforces the gate server-side, so this is purely the
 * UI affordance. Reuses the warm EmptyState so the dead-end still feels cared-for.
 */
export function InformesAccessDenied() {
  return (
    <EmptyState
      icon={LockClosedIcon}
      pillar="manage"
      title="Reports are admin-only"
      description="The estate-wide activity history needs the Reports permission. Ask an admin if you need access to this view."
      action={{ label: "Back to dashboard", href: "/dashboard" }}
    />
  );
}
