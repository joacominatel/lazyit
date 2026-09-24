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
import type {
  OAuthAuthorizeRedirect,
  OAuthAuthorizeValidation,
} from '@lazyit/shared';
import type { Request, Response } from 'express';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { AuthorizationService } from './authorization.service';
import { ConsentDecisionRateLimitGuard } from './oauth-rate-limit';

/**
 * The API half of the consent page (`{web}/oauth/authorize`, W3-9). Both endpoints are NOT public: the
 * web server calls them with the user's session Bearer, so the global guard chain authenticates the
 * human and walls off a forced password change; a cross-site form cannot set the header, so there is no
 * cookie-CSRF surface (security.md T-32). The browser never calls them directly.
 *
 * Responses:
 *   - `validate` → 200 `OAuthAuthorizeValidation` (`ok: true` consent data, or `ok: false` + refusal —
 *     render an error page, never redirect).
 *   - `decision` → 200 `OAuthAuthorizeRedirect` (the client's redirect with a code, or `access_denied`);
 *     403 `{ refusal }` for a refusal; 403 `{ code: STEP_UP_* }` for the admin-scope password check.
 *   - both → 400 `{ error, redirectTo }` for a request error that belongs to the client: send the
 *     browser to `redirectTo` (it carries `error`, `state` and `iss`).
 *   - both → 404 on an instance without an authorization server.
 */
@ApiExcludeController()
@Controller('oauth/authorize')
export class AuthorizeController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Post('validate')
  @HttpCode(200)
  async validate(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OAuthAuthorizeValidation> {
    res.setHeader('Cache-Control', 'no-store');
    return this.authorization.validate(principal, body);
  }

  @Post('decision')
  @HttpCode(200)
  @UseGuards(ConsentDecisionRateLimitGuard)
  async decision(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OAuthAuthorizeRedirect> {
    res.setHeader('Cache-Control', 'no-store');
    return this.authorization.decision(principal, body, { ip: req.ip ?? null });
  }
}
