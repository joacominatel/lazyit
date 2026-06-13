import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from './human-only.guard';
import { SecretManagerService } from './secret-manager.service';

/**
 * Secret Manager — cross-vault item resolution for the KB masked chip (ADR-0061 §8, the slice-4
 * contract). HUMAN-ONLY (`HumanOnlyGuard`) + RBAC `secret:read`.
 *
 *   - `items/by-handle/:handle` resolves a live item to its envelope + the CALLER'S OWN wrapped-DEK row
 *     for the item's vault — requires LIVE membership of that vault (403 otherwise; 404 if no live handle).
 *     The browser runs the §6 decrypt chain in place; plaintext NEVER round-trips the server.
 *   - `items/handles?q=` is chip autocomplete: live handles (metadata) from the caller's vaults only —
 *     NEVER values.
 */
@ApiTags('secret-manager')
@Controller('secret-manager/items')
@UseGuards(HumanOnlyGuard)
export class ItemsController {
  constructor(private readonly secrets: SecretManagerService) {}

  @Get('handles')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      'Chip autocomplete: handles (metadata) from vaults you are a member of. NEVER values.',
  })
  @ApiQuery({ name: 'q', required: false, type: String })
  handles(@Query('q') q?: string, @CurrentPrincipal() principal?: Principal) {
    return this.secrets.searchHandles(principal, q);
  }

  @Get('by-handle/:handle')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "Chip resolution: a live item's envelope + your wrapped-DEK row (live membership of its vault; else 403)",
  })
  byHandle(
    @Param('handle') handle: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.resolveByHandle(principal, handle);
  }
}
