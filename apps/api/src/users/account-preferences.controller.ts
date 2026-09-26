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
  UpdateUserPreferencesSchema,
  UserPreferencesSchema,
  type UserPreferences,
} from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { UserPreferencesService } from './user-preferences.service';

class UserPreferencesDto extends createZodDto(UserPreferencesSchema) {}
class UpdateUserPreferencesDto extends createZodDto(
  UpdateUserPreferencesSchema,
) {}

/**
 * `/account/preferences` — the caller's language and colour theme, stored per user (issue #1422) so they
 * follow the user across browsers. Self-only (the id comes from the JWT, never a body or param), so no
 * permission is required: any signed-in HUMAN, VIEWER included. Service accounts are refused
 * (ServicePrincipalForbiddenGuard, and fail-closed on an unannotated route anyway): a bot has no UI.
 *
 * Web semantics: the BROWSER's own value wins; the stored value is applied only in a browser with no
 * preference of its own; changing it in the UI saves it here too. `null` = never chosen.
 */
@ApiTags('account')
@Controller('account/preferences')
@UseGuards(ServicePrincipalForbiddenGuard)
export class AccountPreferencesController {
  constructor(private readonly preferences: UserPreferencesService) {}

  @Get()
  @ApiOperation({
    summary: 'Read my language and theme preferences (any user)',
    description:
      'Returns { locale, theme }; null means never chosen. A stored value outside the current catalog ' +
      'reads as null. The browser’s own choice wins over these — they only seed a browser with none.',
  })
  @ApiOkResponse({ type: UserPreferencesDto })
  get(@CurrentUser() user?: User): Promise<UserPreferences> {
    if (!user) throw new UnauthorizedException('Not authenticated');
    return this.preferences.get(user.id);
  }

  @Put()
  @ApiOperation({
    summary: 'Save my language and/or theme preference (any user)',
    description:
      'Each key is optional: omitted = unchanged, null = back to never chosen, a value sets it. ' +
      'locale ∈ en|es, theme ∈ light|dark|system; an unknown key or value, or an empty body, is a 400. ' +
      'Returns the fresh preferences. Not recorded in user history (a personal display setting).',
  })
  @ApiOkResponse({ type: UserPreferencesDto })
  update(
    @Body() dto: UpdateUserPreferencesDto,
    @CurrentUser() user?: User,
  ): Promise<UserPreferences> {
    if (!user) throw new UnauthorizedException('Not authenticated');
    return this.preferences.update(user.id, dto);
  }
}
