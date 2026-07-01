import {
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  SendTestEmailResultSchema,
  SendTestEmailSchema,
  SmtpSettingsSchema,
  UpdateSmtpSettingsSchema,
  type SendTestEmailResult,
  type SmtpSettings,
} from '@lazyit/shared';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { SmtpService } from './smtp.service';
import { SmtpSecretKeyMissingError } from './smtp.crypto';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class SmtpSettingsDto extends createZodDto(SmtpSettingsSchema) {}
class UpdateSmtpSettingsDto extends createZodDto(UpdateSmtpSettingsSchema) {}
class SendTestEmailDto extends createZodDto(SendTestEmailSchema) {}
class SendTestEmailResultDto extends createZodDto(SendTestEmailResultSchema) {}

/**
 * SmtpController — the Settings → Instance → SMTP surface (issue #615, ADR-0079). Lives under
 * `/config/smtp` alongside the rest of the config surface (mirrors `/config/asset-tag-scheme`).
 *
 * All three handlers are gated by `settings:manage` (the instance-config admin permission) and forbidden
 * to service principals (a bot must never reconfigure org-wide outbound email), matching the config
 * posture. The password is WRITE-ONLY: `GET` returns only `passwordSet`, never the value.
 */
@ApiTags('config')
@Controller('config/smtp')
export class SmtpController {
  constructor(private readonly service: SmtpService) {}

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Get()
  @ApiOperation({
    summary: 'Read the instance SMTP settings (ADMIN — settings:manage)',
    description:
      'Returns the single SmtpSettings config row, or its explicit DISABLED default when none has been ' +
      'configured — never a 404. The password is WRITE-ONLY: the response carries `passwordSet` (whether ' +
      'a password is stored), NEVER the value itself. Off by default (ADR-0079).',
  })
  @ApiOkResponse({ type: SmtpSettingsDto })
  get(): Promise<SmtpSettings> {
    return this.service.getSettings();
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Put()
  @ApiOperation({
    summary: 'Configure the instance SMTP settings (ADMIN — settings:manage)',
    description:
      'Upserts the single config row. `enabled` is the master switch for outbound email. The `password` ' +
      'is write-only: omit it (or send empty) to KEEP the stored password, or send a non-empty value to ' +
      'set/rotate it (encrypted at rest under SMTP_SECRET_KEY). Returns 409 if a password is supplied but ' +
      'SMTP_SECRET_KEY is not configured. Returns the redacted settings.',
  })
  @ApiOkResponse({ type: SmtpSettingsDto })
  async update(@Body() dto: UpdateSmtpSettingsDto): Promise<SmtpSettings> {
    try {
      return await this.service.updateSettings(dto);
    } catch (err) {
      if (err instanceof SmtpSecretKeyMissingError) {
        // A password write with no server key — a config precondition, surfaced as a clean 409.
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Post('test')
  @ApiOperation({
    summary:
      'Send a test email with the saved SMTP settings (ADMIN — settings:manage)',
    description:
      'Sends a REAL one-off test email to `to` using the currently-saved config (email need NOT be ' +
      'enabled — test before turning it on). Always 200 with `{ ok, error }`: `ok:false` + a short, ' +
      'non-secret `error` on a connection/auth failure (a bad relay is reported, not crashed).',
  })
  @ApiOkResponse({ type: SendTestEmailResultDto })
  test(@Body() dto: SendTestEmailDto): Promise<SendTestEmailResult> {
    return this.service.sendTest(dto.to);
  }
}
