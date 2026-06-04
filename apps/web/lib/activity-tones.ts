import type { StatusTone } from "@/components/ui/status-badge";

/**
 * Activity action → StatusBadge tone + human label, for the Reports/Informes screen.
 *
 * The action verbs are the real ones the `recent_activity` view emits (see
 * `@lazyit/shared` recent-activity.ts): created, status_changed, location_changed, assigned,
 * released, granted, revoked, stock_in, stock_out, stock_adjustment, plus the UserHistory verbs
 * (DEBT-2, issue #185): updated, role_changed, password_reset_sent, deleted, restored.
 *
 * Tone is carried by the SOLID `StatusBadge` (its `*-foreground` is AA-verified), so a coloured
 * action chip is always readable on the bone — the hue never sits as small coloured text
 * (ADR-0049). The mapping reads the verb's "shape":
 *   - additive / granting (created, assigned, granted, stock_in, restored) → success/info (a thing began).
 *   - removing / revoking (released, revoked, stock_out, deleted)          → danger (a thing was taken away).
 *   - stock churn (stock_adjustment)                                       → warning (attention-worthy count change).
 *   - neutral state moves (status_changed, location_changed, updated)      → info / neutral.
 *   - notable account changes (role_changed)                               → warning (a privilege moved).
 *   - one-off side effects (password_reset_sent)                           → info (an action was taken).
 * Anything unmapped falls back to `neutral` so a new verb never crashes the screen.
 */

interface ActionMeta {
  tone: StatusTone;
  /** A short, human-readable label for the action (Title Case), used in the badge + the filter. */
  label: string;
}

const ACTION_META: Record<string, ActionMeta> = {
  created: { tone: "info", label: "Created" },
  status_changed: { tone: "neutral", label: "Status changed" },
  location_changed: { tone: "info", label: "Location changed" },
  assigned: { tone: "success", label: "Assigned" },
  released: { tone: "danger", label: "Released" },
  granted: { tone: "success", label: "Granted" },
  revoked: { tone: "danger", label: "Revoked" },
  stock_in: { tone: "success", label: "Stock in" },
  stock_out: { tone: "danger", label: "Stock out" },
  stock_adjustment: { tone: "warning", label: "Stock adjustment" },
  // UserHistory verbs (DEBT-2, issue #185). `created` already maps above (shared with AssetHistory).
  updated: { tone: "info", label: "Updated" },
  role_changed: { tone: "warning", label: "Role changed" },
  password_reset_sent: { tone: "info", label: "Password reset sent" },
  deleted: { tone: "danger", label: "Deleted" },
  restored: { tone: "success", label: "Restored" },
};

/** The {@link StatusBadge} tone for an activity action verb. Falls back to `neutral`. */
export function actionTone(action: string): StatusTone {
  return ACTION_META[action]?.tone ?? "neutral";
}

/**
 * A human-readable label for an activity action verb (e.g. `stock_in` → "Stock in"). Falls back to
 * a de-snaked Title-Case of the raw verb so an unmapped action still reads cleanly.
 */
export function actionLabel(action: string): string {
  const known = ACTION_META[action]?.label;
  if (known) return known;
  const words = action.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
