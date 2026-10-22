import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  NotificationEmailPreferences,
  NotificationType,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMAIL_NOTIFICATION_TYPES,
  EMAIL_NOTIFICATION_TYPE_SET,
  SECURITY_NOTICE_NOTIFICATION_TYPES,
  isSecurityNoticeType,
} from './email.constants';

/** The wire shape for a stored opt-out list: security notices are never reported as opted out (#1699). */
function toPreferences(stored: string[]): NotificationEmailPreferences {
  return {
    emailableTypes: [...EMAIL_NOTIFICATION_TYPES],
    optedOutTypes: (stored as NotificationType[]).filter(
      (type) => !isSecurityNoticeType(type),
    ),
    mandatoryTypes: [...SECURITY_NOTICE_NOTIFICATION_TYPES],
  };
}

/**
 * NotificationPreferencesService — the self-service read/write of a user's per-type EMAIL opt-out
 * (issue #879). Email-channel ONLY: it never touches the in-app bell. The stored shape is the flat
 * `User.notificationEmailOptOutTypes String[]` (opt-OUT semantics / default-ON). The emailable catalog
 * (which types CAN be emailed) lives api-side in {@link EMAIL_NOTIFICATION_TYPES}; the read returns it so
 * the UI renders one toggle per emailable type, and the write rejects any non-emailable entry (a toggle
 * for a bell-only type is meaningless).
 *
 * SECURITY NOTICES (#1699, `SECURITY_NOTICE_NOTIFICATION_TYPES`) are emailed regardless of the opt-out.
 * They are listed in `mandatoryTypes`, never reported in `optedOutTypes` (a legacy stored entry is ignored
 * on read — no migration), and dropped from a write instead of refused, so the stored list self-heals on
 * the next save without breaking a client that echoes the old entry back.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the caller's email preferences: the full emailable catalog (for rendering) plus the subset the
   * caller has currently opted out of. Echoes what is stored (a stale/non-emailable stored value is inert
   * on the send path but still shown here), except a security notice, which cannot be opted out of.
   */
  async get(userId: string): Promise<NotificationEmailPreferences> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { notificationEmailOptOutTypes: true },
    });
    return toPreferences(user.notificationEmailOptOutTypes);
  }

  /**
   * Replace the caller's opt-out set (idempotent PUT — the body is the full desired list, not a delta).
   * Every entry must be EMAILABLE (a known type on the api-side allowlist) → 400 otherwise. A security
   * notice is dropped. De-duplicates before storing. Returns the fresh preferences so the client needs no refetch.
   */
  async update(
    userId: string,
    optedOutTypes: NotificationType[],
  ): Promise<NotificationEmailPreferences> {
    const invalid = optedOutTypes.filter(
      (type) => !EMAIL_NOTIFICATION_TYPE_SET.has(type),
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Not emailable notification type(s): ${invalid.join(', ')}. ` +
          `Only emailable types can be opted out of.`,
      );
    }
    // A security notice cannot be opted out of: drop it (never 400), so the stored list self-heals.
    const deduped = [
      ...new Set(optedOutTypes.filter((type) => !isSecurityNoticeType(type))),
    ];
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { notificationEmailOptOutTypes: deduped },
      select: { notificationEmailOptOutTypes: true },
    });
    return toPreferences(user.notificationEmailOptOutTypes);
  }
}
