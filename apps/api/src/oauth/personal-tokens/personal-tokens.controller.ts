import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  CreatePersonalTokenSchema,
  type OAuthGrant,
  type PersonalTokenCreated,
} from '@lazyit/shared';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import type { User } from '../../../generated/prisma/client';
import { CurrentUser } from '../../auth/current-user.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import { PersonalTokensService } from './personal-tokens.service';

class CreatePersonalTokenDto extends createZodDto(CreatePersonalTokenSchema) {}

/**
 * Personal MCP tokens (`lan` instances; ADR-0097 decision 9; mcp-and-oauth.md §5.4; synthesis §4.7).
 * Human sessions holding `ai:connect` only — a Service Account never mints a personal token.
 * Browser path: `/api/oauth/personal-tokens…` (Caddy strips `/api`).
 *   - `POST /oauth/personal-tokens` → 201 `PersonalTokenCreated` — the cleartext `token` EXACTLY ONCE,
 *     `Cache-Control: no-store`. 403 `{ code: "OAUTH_INSTANCE" }` on an HTTPS instance (OAuth is the only
 *     path there), 403 `{ code: "AI_DISABLED" }` while MCP is switched off (or in the shim), 409 past
 *     the per-user cap.
 *   - `GET /oauth/personal-tokens` → the caller's live personal tokens (never a token or a hash).
 *   - `DELETE /oauth/personal-tokens/:id` → 204; only the caller's own personal token, 404 otherwise.
 *     (`DELETE /oauth/grants/:id` revokes them too, and is the admin's path.)
 * Listing and revoking stay available whatever the mode or the MCP switch, so nothing that exists is
 * ever unmanageable.
 */
@ApiExcludeController()
@Controller('oauth/personal-tokens')
@UseGuards(ServicePrincipalForbiddenGuard)
export class PersonalTokensController {
  constructor(private readonly personalTokens: PersonalTokensService) {}

  @Post()
  @RequirePermission('ai:connect')
  async create(
    @Body() dto: CreatePersonalTokenDto,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PersonalTokenCreated> {
    res.setHeader('Cache-Control', 'no-store');
    return this.personalTokens.create(user, dto, { ip: req.ip ?? null });
  }

  @Get()
  @RequirePermission('ai:connect')
  list(@CurrentUser() user: User): Promise<OAuthGrant[]> {
    return this.personalTokens.listMine(user);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ): Promise<void> {
    await this.personalTokens.revokeMine(user, id, { ip: req.ip ?? null });
  }
}
