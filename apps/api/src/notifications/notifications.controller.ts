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
import { NotificationsService } from './notifications.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { isHumanPrincipal, type Principal } from '../auth/principal';
import { parsePageQuery } from '../common/parse-page-query';

/**
 * The in-app notification bell endpoints (ADR-0056 §2) — POLL delivery in v1. Every endpoint is gated
 * by `notification:read` (seeded ADMIN-only), so a non-admin caller is 403'd by the global permission
 * guard before reaching here. SSE is a Phase-2 upgrade behind these SAME endpoints — the wire shapes do
 * not change when it lands.
 *
 * Read state is a per-USER join (`NotificationRead.userId`), so the bell is for HUMAN admins: a handler
 * here resolves the caller to a human user id and 403s a service-account principal (which has no
 * per-admin read state in v1) even if it somehow holds the permission.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('notification:read')
  @ApiOperation({
    summary:
      "The caller's notification feed (newest-first, paged) — unread + read, each with its per-caller read flag.",
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
      this.requireHumanId(principal),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get('unread-count')
  @RequirePermission('notification:read')
  @ApiOperation({ summary: "The caller's unread notification count (the bell badge)." })
  @ApiOkResponse({ description: 'The unread count: { unread: number }.' })
  async unreadCount(
    @CurrentPrincipal() principal?: Principal,
  ): Promise<UnreadCount> {
    const unread = await this.notifications.unreadCount(
      this.requireHumanId(principal),
    );
    return { unread };
  }

  @Patch(':id/read')
  @RequirePermission('notification:read')
  @ApiOperation({
    summary:
      'Mark one notification read for the caller (idempotent). Returns the rows marked + the fresh unread count.',
  })
  @ApiOkResponse({ description: 'The mark-read result: { marked, unread }.' })
  markRead(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<MarkReadResult> {
    return this.notifications.markRead(this.requireHumanId(principal), id);
  }

  @Patch('read-all')
  @RequirePermission('notification:read')
  @ApiOperation({
    summary:
      "Mark all of the caller's currently-unread notifications read. Returns the rows marked + the fresh (0) unread count.",
  })
  @ApiOkResponse({ description: 'The mark-read result: { marked, unread }.' })
  markAllRead(
    @CurrentPrincipal() principal?: Principal,
  ): Promise<MarkReadResult> {
    return this.notifications.markAllRead(this.requireHumanId(principal));
  }

  /**
   * Resolve the caller to a HUMAN user id (the per-admin read-state key). A service-account principal —
   * which has no per-admin read state in v1 — is 403'd even if it holds `notification:read`; the bell is
   * a human-admin surface (ADR-0056 §8).
   */
  private requireHumanId(principal?: Principal): string {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException(
        'The notification bell is available to human administrators only.',
      );
    }
    return principal.user.id;
  }
}
