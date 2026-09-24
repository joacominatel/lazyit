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
import {
  ClientRegistrationService,
  type ClientRegistrationResponse,
} from './client-registration.service';
import { RegisterRateLimitGuard } from './oauth-rate-limit';

/**
 * `POST /oauth/register` (public path) — RFC 7591 Dynamic Client Registration, public clients only,
 * gated by the client allowlist and rate-limited per IP. Answers 404 while MCP is off or without an
 * HTTPS issuer.
 */
@ApiExcludeController()
@Public()
@Controller('oauth')
export class RegisterController {
  constructor(
    private readonly registrations: ClientRegistrationService,
    private readonly policy: OAuthPolicyService,
  ) {}

  @Post('register')
  @HttpCode(201)
  @UseGuards(RegisterRateLimitGuard)
  async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClientRegistrationResponse> {
    res.setHeader('Cache-Control', 'no-store');
    // 404 without an HTTPS issuer or with MCP off — checked at the route, before the body is read.
    await this.policy.requireEnabled();
    return this.registrations.register(body, { ip: req.ip ?? null });
  }
}
