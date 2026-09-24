import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { OAuthGrant } from '@lazyit/shared';
import type { Request } from 'express';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { type AdminOAuthGrant, GrantsService } from './grants.service';

/**
 * Connected apps (synthesis §4.7, R9). Human sessions only — a service account never manages OAuth
 * delegations. Browser path: `/api/oauth/grants…` (Caddy strips `/api`).
 *   - `GET /oauth/grants/mine` — the caller's live connections (`ai:connect`).
 *   - `GET /oauth/grants?userId=` — everyone's, or one user's (`settings:manage`). Each item adds
 *     `userId` to the shared `OAuthGrant` shape.
 *   - `DELETE /oauth/grants/:id` — the owner always; anyone else needs `settings:manage`; 404 otherwise.
 */
@Controller('oauth/grants')
@UseGuards(ServicePrincipalForbiddenGuard)
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get('mine')
  @RequirePermission('ai:connect')
  listMine(@CurrentUser() user: User): Promise<OAuthGrant[]> {
    return this.grants.listMine(user);
  }

  @Get()
  @RequirePermission('settings:manage')
  list(@Query('userId') userId?: string): Promise<AdminOAuthGrant[]> {
    return this.grants.listForAdmin(parseUuidQuery(userId, 'userId'));
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ): Promise<void> {
    await this.grants.revoke(user, id, req.ip ?? null);
  }
}
