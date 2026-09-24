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
import { OAuthProtocolError, readProtocolParams } from './oauth-errors';
import { TokenRateLimitGuard } from './oauth-rate-limit';
import {
  OAuthTokenService,
  type OAuthTokenResponse,
} from './oauth-token.service';

/**
 * `POST /oauth/token` (public path) — the token endpoint for public clients (RFC 6749 §3.2, OAuth 2.1).
 * Accepts `application/x-www-form-urlencoded` (what every client sends; JSON is tolerated). Grants:
 * `authorization_code` (PKCE S256) and `refresh_token`; nothing else — no `client_credentials`, no
 * password grant, no `id_token`. Every response, success or error, is `Cache-Control: no-store`.
 *
 * The request body carries codes, verifiers and refresh tokens: pino-http never logs bodies, and
 * `logging.config.ts` redacts these fields as defense in depth.
 */
@ApiExcludeController()
@Public()
@Controller('oauth')
export class TokenController {
  constructor(
    private readonly tokens: OAuthTokenService,
    private readonly policy: OAuthPolicyService,
  ) {}

  @Post('token')
  @HttpCode(200)
  @UseGuards(TokenRateLimitGuard)
  async token(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OAuthTokenResponse> {
    res.setHeader('Cache-Control', 'no-store');
    // 404 without an HTTPS issuer or with MCP off — checked at the route, before the body is read.
    await this.policy.requireEnabled();
    res.setHeader('Pragma', 'no-cache');
    const params = readProtocolParams(body);
    const ctx = { ip: req.ip ?? null };
    switch (params.grant_type) {
      case 'authorization_code':
        return this.tokens.exchangeAuthorizationCode(params, ctx);
      case 'refresh_token':
        return this.tokens.refresh(params, ctx);
      case undefined:
        throw new OAuthProtocolError(
          'invalid_request',
          'grant_type is required',
        );
      default:
        throw new OAuthProtocolError('unsupported_grant_type');
    }
  }
}
