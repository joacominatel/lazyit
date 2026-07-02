import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  EnqueueUpdateSchema,
  UpdateRunSchema,
  UpdateSettingsSchema,
  UpdateStatusSchema,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from '../secret-manager/human-only.guard';
import { UpdateService } from './update.service';

// DTOs from the shared zod schemas (TS type + OpenAPI schema; global ZodValidationPipe convention).
class EnqueueUpdateDto extends createZodDto(EnqueueUpdateSchema) {}
class UpdateSettingsDto extends createZodDto(UpdateSettingsSchema) {}
class UpdateStatusDto extends createZodDto(UpdateStatusSchema) {}
class UpdateRunDto extends createZodDto(UpdateRunSchema) {}

/**
 * UpdateController — update awareness & the ENQUEUE-ONLY guided update (ADR-0084, issue #904). Extends
 * the ADR-0083 `/instance` identity surface with the consumption half. Four routes:
 *   - GET  /instance/update-status    — the whole "Version & updates" card (current, latest, N behind,
 *                                        last checked, active run + history). ADMIN read (settings:read).
 *   - GET  /instance/update-settings  — the opt-in toggle's current value.
 *   - PUT  /instance/update-settings  — flip the opt-in weekly check (settings:manage).
 *   - POST /instance/update           — ENQUEUE a guided update (settings:manage, HUMAN-ONLY). Inserts
 *                                       an UpdateRun and returns it; the UI then shows the operator the
 *                                       exact `./infra/update.sh vX.Y.Z` command. EXECUTES NOTHING.
 *
 * RED LINE: this controller never runs an update — no docker, no shell, no host reach. The POST only
 * records intent (a Postgres row); the host script is the only thing that mutates the host, run by a
 * human. HumanOnlyGuard is defense-in-depth (a service account already can't hold settings:manage).
 */
@ApiTags('instance')
@Controller('instance')
export class UpdateController {
  constructor(private readonly updates: UpdateService) {}

  @RequirePermission('settings:read')
  @Get('update-status')
  @ApiOperation({
    summary:
      'The Version & updates card (ADR-0084): running version, latest known release, N behind, last checked, active run + history. Reads the cache — never fetches GitHub.',
  })
  @ApiOkResponse({ type: UpdateStatusDto })
  getStatus() {
    return this.updates.getStatus();
  }

  @RequirePermission('settings:read')
  @Get('update-settings')
  @ApiOperation({ summary: 'The update-check opt-in setting (ADR-0084).' })
  @ApiOkResponse({ type: UpdateSettingsDto })
  getSettings() {
    return this.updates.getSettings();
  }

  @RequirePermission('settings:manage')
  @Put('update-settings')
  @ApiOperation({
    summary:
      'Flip the opt-in weekly GitHub update check (default OFF, beacon-free, fail-soft). ADR-0084 §1.',
  })
  @ApiOkResponse({ type: UpdateSettingsDto })
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.updates.updateSettings(dto);
  }

  @UseGuards(HumanOnlyGuard)
  @RequirePermission('settings:manage')
  @Post('update')
  @ApiOperation({
    summary:
      'ENQUEUE a guided update (ADR-0084 §4). Records an append-only UpdateRun and returns it; the operator then runs ./infra/update.sh <toVersion> on the host. Executes NOTHING — no docker, no auto-apply.',
  })
  @ApiOkResponse({ type: UpdateRunDto })
  enqueue(
    @Body() dto: EnqueueUpdateDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.updates.enqueue(dto, principal);
  }
}
