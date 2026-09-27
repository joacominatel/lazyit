import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
 * "Sign out everywhere" stays `POST /auth/logout`.
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
