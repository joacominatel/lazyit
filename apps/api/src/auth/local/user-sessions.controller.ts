import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { UserSessionListSchema, type UserSessionList } from '@lazyit/shared';
import type { Request } from 'express';
import type { User } from '../../../generated/prisma/client';
import { CurrentUser } from '../current-user.decorator';
import { ServicePrincipalForbiddenGuard } from '../service-principal-forbidden.guard';
import type { LocalSessionContext } from './local-credential.service';
import { sessionMetaFromRequest } from './user-session.store';
import { UserSessionsService } from './user-sessions.service';

class UserSessionListDto extends createZodDto(UserSessionListSchema) {}

type SessionRequest = Request & { localSession?: LocalSessionContext };

/**
 * The caller's own per-device sessions (issue #1420, ADR-0086 §9). Authenticated humans only — a service
 * principal holds no session and is refused outright. Unannotated on purpose: every human may manage their
 * own sessions (INV-8), and every query is scoped to the caller's id.
 *   - `GET /auth/sessions` → the live sessions, `current` flagged; `currentIsLegacy` when the caller's
 *     token predates per-device sessions. Empty outside AUTH_MODE=local.
 *   - `DELETE /auth/sessions/:id` → 204; ends that session (the current one = sign out of this device).
 *     404 for anything that is not one of the caller's live sessions.
 *   - `POST /auth/sessions/revoke-all` → 204; "Sign out everywhere and disconnect AI apps" (#1699): bumps
 *     both `sessionEpoch` and `mcpCredentialEpoch` and ends every session, in every auth mode.
 * The plain sign-out stays `POST /auth/logout` (web sessions only, local mode only).
 */
@ApiTags('auth')
@Controller('auth/sessions')
@UseGuards(ServicePrincipalForbiddenGuard)
export class UserSessionsController {
  constructor(private readonly sessions: UserSessionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List your own sessions (authenticated, local mode)',
    description:
      'One entry per signed-in device: browser/OS parsed from the sign-in User-Agent, sign-in IP, ' +
      'created and last-seen times (last-seen is throttled), expiry (null = "keep me signed in") and ' +
      '`current` for the session making the request. Empty outside AUTH_MODE=local.',
  })
  @ApiOkResponse({ type: UserSessionListDto })
  async list(
    @Req() req: SessionRequest,
    @CurrentUser() user?: User,
  ): Promise<UserSessionList> {
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    return this.sessions.list(user, req.localSession?.sessionId ?? null);
  }

  // Declared before `:id` routes on purpose (static path), though the verbs differ anyway.
  @Post('revoke-all')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Sign out everywhere and disconnect AI apps (authenticated, any auth mode)',
    description:
      "Bumps the caller's session epoch AND MCP credential epoch and ends every per-device session, in " +
      'one transaction: every lazyit session token (this one included), every AI chat delegation, and ' +
      'every OAuth-connected AI app and personal MCP token of the caller stop working. Works in local and ' +
      'OIDC mode (in OIDC mode the identity provider session itself is not ended — the web drops its ' +
      'cookie). Unlike POST /auth/logout, which ends web sessions only. Audited as ' +
      'SIGNED_OUT_EVERYWHERE in the OAuth audit trail. Human users only.',
  })
  @ApiNoContentResponse()
  async revokeAll(
    @Req() req: SessionRequest,
    @CurrentUser() user?: User,
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    await this.sessions.signOutEverywhere(user, sessionMetaFromRequest(req).ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'End one of your sessions (authenticated, local mode)',
    description:
      "Ends that device's session at once: its token is refused from the next request. Ending the " +
      'current session signs this device out. 404 when the id is not one of your live sessions.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async end(
    @Param('id') id: string,
    @Req() req: SessionRequest,
    @CurrentUser() user?: User,
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    await this.sessions.end(user, id, req.localSession?.sessionId ?? null);
  }
}
