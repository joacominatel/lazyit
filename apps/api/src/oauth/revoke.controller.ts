import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { OAuthPolicyService } from './oauth-policy.service';
import { readProtocolParams } from './oauth-errors';
import { RevokeRateLimitGuard } from './oauth-rate-limit';
import { OAuthTokenService } from './oauth-token.service';

/**
 * `POST /oauth/revoke` (public path) — RFC 7009 token revocation for public clients. Answers 200 with an
 * empty body whether or not the token was known (§2.2), so it is no token oracle. Revoking either the
 * access or the refresh token revokes the whole grant.
 */
@ApiExcludeController()
@Public()
@Controller('oauth')
export class RevokeController {
  constructor(
    private readonly tokens: OAuthTokenService,
    private readonly policy: OAuthPolicyService,
  ) {}

  @Post('revoke')
  @HttpCode(200)
  @UseGuards(RevokeRateLimitGuard)
  async revoke(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    // 404 without an HTTPS issuer or with MCP off — checked at the route, before the body is read.
    await this.policy.requireEnabled();
    await this.tokens.revokeByToken(readProtocolParams(body), {
      ip: req.ip ?? null,
    });
  }
}
