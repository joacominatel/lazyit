import type { NotificationType } from '@lazyit/shared';

/**
 * Wiring constants for the outbound-email subsystem (issue #615, ADR-0079). Pure data — NO DI — so both
 * the SmtpModule (the worker/consumer) and the NotificationsService (the producer seam) can import the
 * queue name + the allowlist without a module cycle.
 */

/** The BullMQ queue name for outbound email jobs (in-process worker on the shared Valkey, ADR-0053). */
export const EMAIL_QUEUE = 'email-dispatch';

/** The job name added to the email queue. */
export const EMAIL_JOB_NAME = 'notification-email';

/** The fixed singleton primary key of the SmtpSettings row (mirrors AssetTagScheme, ADR-0063/0079). */
export const SMTP_SETTINGS_SINGLETON_ID = 'singleton';

/**
 * The env var the 32-byte AES-256-GCM master key for the SMTP password is read from — its OWN key axis,
 * SEPARATE from `WORKFLOW_SECRET_KEY` ("one key per subsystem", ADR-0054/0079). Unlike the workflow key
 * (fail-loud at boot, the engine is always on), this is OPTIONAL: the app boots without it and SMTP is
 * simply unavailable; it is required only when an admin actually SAVES an SMTP password.
 */
export const SMTP_SECRET_KEY_ENV = 'SMTP_SECRET_KEY';

/**
 * The CURATED allowlist of notification types that are ALSO emailed when outbound email is enabled
 * (ADR-0079, the "start small" set). Everything else stays bell-only. Deliberately the clearly
 * OPERATIONAL nudges a small team wants in their inbox — not the per-user login nudge
 * (`secret.vault_setup`) nor the sensitive-audit stream (`permission_widened`, `infra.agent_offline`),
 * which stay bell-only in v1 (candidate additions — see ADR-0079 forks). No per-event rules engine: this
 * flat allowlist + the single global on/off IS the routing (one line before fifty).
 */
export const EMAIL_NOTIFICATION_TYPES = [
  'critical_app_access',
  'admin_granted',
  'low_stock',
  'workflow.manual_task',
  'workflow.run_failed',
] as const satisfies readonly NotificationType[];

/** O(1) membership set for the allowlist. */
export const EMAIL_NOTIFICATION_TYPE_SET: ReadonlySet<NotificationType> =
  new Set(EMAIL_NOTIFICATION_TYPES);

/** True when this notification type is routed to email (subject to the global on/off + SMTP config). */
export function isEmailableNotificationType(type: NotificationType): boolean {
  return EMAIL_NOTIFICATION_TYPE_SET.has(type);
}

/**
 * The payload enqueued per emailable notification — everything the worker needs to resolve recipients +
 * render, so it never re-reads the Notification row. `recipientUserId` null = BROADCAST (email every
 * `notification:read` holder); a uuid = TARGETED (email that one user), mirroring the bell audience
 * (ADR-0056). All fields are REDACTED (names/ids only — INV-6); no secrets/bodies ride the queue.
 */
export interface NotificationEmailJob {
  notificationId: string | null;
  type: NotificationType;
  severity: string;
  title: string;
  summary: string | null;
  entityType: string | null;
  entityId: string | null;
  /** null = broadcast to notification:read holders; a uuid = targeted to that user. */
  recipientUserId: string | null;
}
