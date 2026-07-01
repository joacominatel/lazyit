import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import { SecretManagerService } from './secret-manager.service';
import { ServiceOnlyGuard } from './service-only.guard';

/**
 * Secret Manager — the HEADLESS FETCH surface (ADR-0080, programmatic secret retrieval). The ONLY
 * Secret-Manager route a SERVICE ACCOUNT may reach: it is SERVICE-ONLY (`ServiceOnlyGuard` — the inverse of
 * the human-only guard on every other secret route) and gated on the narrow, machine-only `secret:fetch`
 * verb. A human (even an ADMIN who holds `secret:fetch` via the full catalog) is refused at the guard.
 *
 * The response is CIPHERTEXT + public material ONLY — the SA's token-wrapped private key, the vault DEK
 * wrapped to the SA, and item ciphertext. The server NEVER decrypts (INV-10): the token-derived KEK is
 * computed CLIENT-SIDE by the `lazyit-fetch` CLI, which does every unwrap. TWO authorization layers apply
 * (mirroring the human model): `secret:fetch` (this gate) AND a live crypto membership (the service checks
 * a `ServiceAccountVaultMembership` for the vault). EVERY fetch is audited (ITEMS_FETCHED).
 *
 * `vaultId` is a cuid (no `ParseUUIDPipe`) — validated by existence + membership in the service.
 */
@ApiTags('secret-manager')
@Controller('secret-fetch')
@UseGuards(ServiceOnlyGuard)
export class SecretFetchController {
  constructor(private readonly secrets: SecretManagerService) {}

  @Get()
  @RequirePermission('secret:fetch')
  @ApiOperation({
    summary:
      'List the vaults this service account may fetch (id + name; metadata only)',
  })
  list(@CurrentPrincipal() principal?: Principal) {
    return this.secrets.listFetchableVaults(principal);
  }

  @Get(':vaultId')
  @RequirePermission('secret:fetch')
  @ApiOperation({
    summary:
      "Headless fetch: the SA's wrapped keypair + wrapped DEK + item CIPHERTEXT for a vault it is a member of (client-side decrypt; INV-10). Audited.",
  })
  @ApiOkResponse({
    description:
      'Ciphertext + wrapped keys only. The server NEVER decrypts; the lazyit-fetch CLI unwraps client-side.',
  })
  fetch(
    @Param('vaultId') vaultId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.fetchVaultForServiceAccount(principal, vaultId);
  }
}
