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

/**
 * Action verb → tone. The human label is NOT held here anymore: it's localized at the render site
 * via `shared.activity.action.*` (issue #204), keyed by the same raw action VALUE (never translated)
 * — see {@link actionLabel}.
 */
const ACTION_TONE: Record<string, StatusTone> = {
  created: "info",
  status_changed: "neutral",
  location_changed: "info",
  assigned: "success",
  released: "danger",
  granted: "success",
  revoked: "danger",
  stock_in: "success",
  stock_out: "danger",
  stock_adjustment: "warning",
  // UserHistory verbs (DEBT-2, issue #185). `created` already maps above (shared with AssetHistory).
  updated: "info",
  role_changed: "warning",
  password_reset_sent: "info",
  deleted: "danger",
  restored: "success",
};

/** The {@link StatusBadge} tone for an activity action verb. Falls back to `neutral`. */
export function actionTone(action: string): StatusTone {
  return ACTION_TONE[action] ?? "neutral";
}

/**
 * Minimal shape of a next-intl translator scoped to the `shared.activity.action` namespace — the
 * caller threads its `useTranslations("shared.activity.action")` so this pure (non-React) util can
 * resolve the localized verb label without importing React or hardcoding English.
 */
type ActionTranslator = ((key: string) => string) & {
  has: (key: string) => boolean;
};

/**
 * A localized, human-readable label for an activity action verb (e.g. `stock_in` → "Stock in" /
 * "Entrada de stock"), resolved via `shared.activity.action.{action}`. The caller passes its
 * `useTranslations("shared.activity.action")` translator. Unmapped verbs (no key for the current
 * locale) fall back to a de-snaked Title-Case of the raw value so a new action still reads cleanly.
 */
export function actionLabel(action: string, t: ActionTranslator): string {
  if (t.has(action)) return t(action);
  const words = action.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
