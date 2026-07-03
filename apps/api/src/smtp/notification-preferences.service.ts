import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  NotificationEmailPreferences,
  NotificationType,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMAIL_NOTIFICATION_TYPES,
  EMAIL_NOTIFICATION_TYPE_SET,
} from './email.constants';

/**
 * NotificationPreferencesService — the self-service read/write of a user's per-type EMAIL opt-out
 * (issue #879). Email-channel ONLY: it never touches the in-app bell. The stored shape is the flat
 * `User.notificationEmailOptOutTypes String[]` (opt-OUT semantics / default-ON). The emailable catalog
 * (which types CAN be emailed) lives api-side in {@link EMAIL_NOTIFICATION_TYPES}; the read returns it so
 * the UI renders one toggle per emailable type, and the write rejects any non-emailable entry (a toggle
 * for a bell-only type is meaningless).
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the caller's email preferences: the full emailable catalog (for rendering) plus the subset the
   * caller has currently opted out of. Echoes exactly what is stored (a stale/non-emailable stored value
   * is inert on the send path but still shown here).
   */
  async get(userId: string): Promise<NotificationEmailPreferences> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { notificationEmailOptOutTypes: true },
    });
    return {
      emailableTypes: [...EMAIL_NOTIFICATION_TYPES],
      optedOutTypes: user.notificationEmailOptOutTypes as NotificationType[],
    };
  }

  /**
   * Replace the caller's opt-out set (idempotent PUT — the body is the full desired list, not a delta).
   * Every entry must be EMAILABLE (a known type on the api-side allowlist) → 400 otherwise. De-duplicates
   * before storing. Returns the fresh preferences so the client needs no refetch.
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
    const deduped = [...new Set(optedOutTypes)];
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { notificationEmailOptOutTypes: deduped },
      select: { notificationEmailOptOutTypes: true },
    });
    return {
      emailableTypes: [...EMAIL_NOTIFICATION_TYPES],
      optedOutTypes: user.notificationEmailOptOutTypes as NotificationType[],
    };
  }
}
