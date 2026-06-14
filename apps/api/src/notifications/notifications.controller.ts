import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type {
  MarkReadResult,
  Notification,
  Page,
  UnreadCount,
} from '@lazyit/shared';
import {
  NotificationsService,
  type NotificationViewer,
} from './notifications.service';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { isHumanPrincipal, type Principal } from '../auth/principal';
import { parsePageQuery } from '../common/parse-page-query';

/**
 * The in-app notification bell endpoints (ADR-0056 §2) — POLL delivery in v1. SSE is a Phase-2 upgrade
 * behind these SAME endpoints — the wire shapes do not change when it lands.
 *
 * Read-path authZ (ADR-0056 amendment 2026-06-14, #453 — the AUTH-CONTRACT change). v1 gated all four
 * endpoints by `@RequirePermission('notification:read')` (ADMIN-only), so a non-admin was 403'd before
 * reaching the service and could never see the bell. The amendment adds TARGETED per-user notifications:
 * a non-admin must be able to read a notification addressed to THEM (their own targeted rows), without
 * gaining the admin broadcast feed. So the routes are RELAXED to any authenticated human, and the
 * {@link NotificationsService} SCOPES every read by the caller's `{ userId, role }`:
 *   - own targeted rows (`recipientUserId == caller`) — ALWAYS visible; PLUS
 *   - the broadcast set (`recipientUserId IS NULL`) — only if the role holds `notification:read`.
 * The permission is resolved INSIDE the service, so the controller carries no authZ logic beyond
 * forwarding the caller; mark-read/unread-count reuse the same scope, so they are IDOR-safe.
 *
 * Read state is a per-USER join (`NotificationRead.userId`), so the bell is a HUMAN surface: a handler
 * here resolves the caller to a human `{ userId, role }` and 403s a service-account principal (which has
 * no per-user bell state — a targeted recipient is, by construction, a human user).
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary:
      "The caller's notification feed (newest-first, paged) — their own targeted rows always, plus the broadcast set if they hold notification:read. Each item carries its per-caller read flag.",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ description: 'A page of notifications (Page<Notification>).' })
  findAll(
    @CurrentPrincipal() principal?: Principal,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ): Promise<Page<Notification>> {
    return this.notifications.findPage(
      this.requireViewer(principal),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: "The caller's unread notification count (the bell badge), scoped to what they can see." })
  @ApiOkResponse({ description: 'The unread count: { unread: number }.' })
  async unreadCount(
    @CurrentPrincipal() principal?: Principal,
  ): Promise<UnreadCount> {
    const unread = await this.notifications.unreadCount(
      this.requireViewer(principal),
    );
    return { unread };
  }

  @Patch(':id/read')
  @ApiOperation({
    summary:
      'Mark one notification read for the caller (idempotent, IDOR-safe: only a notification the caller can see). Returns the rows marked + the fresh unread count.',
  })
  @ApiOkResponse({ description: 'The mark-read result: { marked, unread }.' })
  markRead(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<MarkReadResult> {
    return this.notifications.markRead(this.requireViewer(principal), id);
  }

  @Patch('read-all')
  @ApiOperation({
    summary:
      "Mark all of the caller's currently-unread VISIBLE notifications read. Returns the rows marked + the fresh (0) unread count.",
  })
  @ApiOkResponse({ description: 'The mark-read result: { marked, unread }.' })
  markAllRead(
    @CurrentPrincipal() principal?: Principal,
  ): Promise<MarkReadResult> {
    return this.notifications.markAllRead(this.requireViewer(principal));
  }

  /**
   * Resolve the caller to a HUMAN {@link NotificationViewer} (`{ userId, role }`) — the per-user
   * read-state key plus the role the service uses to decide broadcast visibility. A service-account
   * principal (no per-user bell state, never a targeted recipient) is 403'd; the bell is a human surface
   * (ADR-0056 §8 / amendment). The route itself is open to any authenticated human; the SERVICE scopes
   * what they actually see.
   */
  private requireViewer(principal?: Principal): NotificationViewer {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException(
        'The notification bell is available to human users only.',
      );
    }
    return { userId: principal.user.id, role: principal.user.role };
  }
}
