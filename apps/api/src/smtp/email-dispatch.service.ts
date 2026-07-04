import { Injectable, Logger } from '@nestjs/common';
import { type Role } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { SmtpService } from './smtp.service';
import {
  buildTransport,
  formatFrom,
  renderNotificationEmail,
} from './email.mailer';
import type { NotificationEmailJob } from './email.constants';
import type { NotificationType } from '@lazyit/shared';

/** The roles email recipient-resolution considers (the full RBAC set — ADR-0046). */
const CANDIDATE_ROLES = [
  'ADMIN',
  'MEMBER',
  'VIEWER',
] as const satisfies readonly Role[];

/**
 * EmailDispatchService — the WORKER-side logic that turns one emailable notification into a sent email
 * (issue #615, ADR-0079). Resolves the SAME audience the bell uses (ADR-0056): a TARGETED notification
 * emails that one user; a BROADCAST emails every `notification:read` holder. Renders the one branded
 * template and sends via the resolved transport. FAIL-SOFT throughout — a missing config, no recipients,
 * or a send error is logged and swallowed; email never affects the notification or the domain write.
 */
@Injectable()
export class EmailDispatchService {
  private readonly logger = new Logger(EmailDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
    private readonly smtp: SmtpService,
  ) {}

  /**
   * Dispatch one job. Resolves the LIVE config (email must be ENABLED), resolves recipient emails, renders
   * once and sends (a broadcast goes out as one message with the recipients in `bcc` so addresses aren't
   * cross-disclosed; a targeted nudge goes to its single `to`). A thrown error propagates to the worker's
   * fail-soft `catch` (which decides retry vs give up).
   */
  async dispatch(job: NotificationEmailJob): Promise<void> {
    const config = await this.smtp.resolveConfig(true);
    if (!config) {
      // Email off or incomplete config — nothing to do (not an error).
      return;
    }

    const emails = await this.resolveRecipientEmails(
      job.recipientUserId,
      job.type,
    );
    if (emails.length === 0) {
      this.logger.debug(
        `email skip (no recipients) type=${job.type} recipient=${job.recipientUserId ?? 'broadcast'}`,
      );
      return;
    }

    const rendered = renderNotificationEmail({
      title: job.title,
      summary: job.summary,
      appUrl: process.env.WEB_ORIGIN ?? null,
      brandName: 'lazyit',
    });
    const transporter = buildTransport(config);
    const targeted = job.recipientUserId != null;
    await transporter.sendMail({
      from: formatFrom(config),
      // Targeted → a single `to`; broadcast → `bcc` the group (privacy) with `to` set to the sender.
      ...(targeted
        ? { to: emails[0] }
        : { to: config.fromAddress, bcc: emails }),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    this.logger.log(
      `email sent type=${job.type} recipients=${emails.length} (${targeted ? 'targeted' : 'broadcast'})`,
    );
  }

  /**
   * Resolve the recipient email addresses for a notification. TARGETED (`recipientUserId` set) → that one
   * live user's email. BROADCAST (null) → the emails of every live, active, non-directory user whose role
   * holds `notification:read` (mirrors the bell's broadcast audience). Blank emails are dropped.
   *
   * PER-USER EMAIL OPT-OUT (issue #879): a user who has listed `type` in their
   * `notificationEmailOptOutTypes` is EXCLUDED from this type's email audience — both a TARGETED nudge to
   * that one user (→ no email) and a BROADCAST (→ that user is dropped from the group). Email-channel only:
   * the in-app bell audience is untouched (that resolution lives elsewhere). Fail-soft is preserved by the
   * worker's outer catch — this method only reads a column and does an array membership check.
   *
   * ponytail: the broadcast audience is resolved per-ROLE via the permission resolver (there is no per-user
   * permission override system); the opt-out is a flat per-user `String[]` filtered in-memory here.
   */
  private async resolveRecipientEmails(
    recipientUserId: string | null,
    type: NotificationType,
  ): Promise<string[]> {
    if (recipientUserId) {
      const user = await this.prisma.user.findFirst({
        where: { id: recipientUserId, isActive: true, deletedAt: null },
        select: { email: true, notificationEmailOptOutTypes: true },
      });
      // Opted OUT of this type by email → no email to this one user (the bell still fired).
      if (user?.notificationEmailOptOutTypes?.includes(type)) return [];
      const email = user?.email?.trim();
      return email ? [email] : [];
    }

    // Broadcast: which roles hold notification:read? (ADMIN always; MEMBER/VIEWER per the matrix.)
    const qualifyingRoles: Role[] = [];
    for (const role of CANDIDATE_ROLES) {
      if (await this.permissions.hasAll(role, ['notification:read'])) {
        qualifyingRoles.push(role);
      }
    }
    if (qualifyingRoles.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: {
        role: { in: qualifyingRoles },
        isActive: true,
        deletedAt: null,
        directoryOnly: false,
      },
      select: { email: true, notificationEmailOptOutTypes: true },
    });
    const seen = new Set<string>();
    for (const u of users) {
      // Drop any user who opted OUT of this type by email (issue #879).
      if (u.notificationEmailOptOutTypes.includes(type)) continue;
      const email = u.email?.trim();
      if (email) seen.add(email);
    }
    return [...seen];
  }
}
