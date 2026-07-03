import {
  Body,
  Controller,
  Get,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  NotificationEmailPreferencesSchema,
  UpdateNotificationEmailPreferencesSchema,
  type NotificationEmailPreferences,
} from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { NotificationPreferencesService } from './notification-preferences.service';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class NotificationEmailPreferencesDto extends createZodDto(
  NotificationEmailPreferencesSchema,
) {}
class UpdateNotificationEmailPreferencesDto extends createZodDto(
  UpdateNotificationEmailPreferencesSchema,
) {}

/**
 * NotificationPreferencesController — the self-service EMAIL notification preferences surface (issue
 * #879), under `/account/notification-preferences`. Every handler acts ONLY on the CALLER's own row: the
 * user id comes from the authenticated JWT (@CurrentUser), NEVER a body/param, so there is no cross-user
 * write and no admin permission is required — any authenticated HUMAN (incl. VIEWER) may manage their own
 * email opt-outs. Service accounts are refused (ServicePrincipalForbiddenGuard): a bot has no inbox and no
 * personal notification preferences. Email-channel only — the in-app bell is unaffected.
 */
@ApiTags('account')
@Controller('account/notification-preferences')
@UseGuards(ServicePrincipalForbiddenGuard)
export class NotificationPreferencesController {
  constructor(private readonly service: NotificationPreferencesService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the caller’s email notification preferences (any user)',
    description:
      'Returns { emailableTypes, optedOutTypes }: the full server-curated catalog of types that CAN be ' +
      'emailed (so the UI renders one toggle per type without hardcoding the allowlist) plus the subset ' +
      'the caller has opted OUT of. Self-only — resolved from the JWT, never a supplied user id. The ' +
      'in-app bell is unaffected (email-channel only).',
  })
  @ApiOkResponse({ type: NotificationEmailPreferencesDto })
  get(@CurrentUser() user?: User): Promise<NotificationEmailPreferences> {
    if (!user) throw new UnauthorizedException('Not authenticated');
    return this.service.get(user.id);
  }

  @Put()
  @ApiOperation({
    summary: 'Replace the caller’s email opt-out set (any user)',
    description:
      'Idempotent full replacement: the body { optedOutTypes } is the complete desired opt-out list, ' +
      'not a delta. Each entry must be a known EMAILABLE notification type (unknown → 400 via the enum; ' +
      'a valid-but-non-emailable type → 400). De-duplicated before storing. Self-only (JWT-keyed). ' +
      'Returns the fresh preferences so the client needs no refetch.',
  })
  @ApiOkResponse({ type: NotificationEmailPreferencesDto })
  update(
    @Body() dto: UpdateNotificationEmailPreferencesDto,
    @CurrentUser() user?: User,
  ): Promise<NotificationEmailPreferences> {
    if (!user) throw new UnauthorizedException('Not authenticated');
    return this.service.update(user.id, dto.optedOutTypes);
  }
}
