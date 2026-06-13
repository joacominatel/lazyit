import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CreateSecretItemSchema,
  CreateSecretVaultSchema,
  CreateVaultMembershipSchema,
  SecretItemSchema,
  SecretVaultSchema,
  UpdateSecretItemSchema,
  UpdateSecretVaultSchema,
  VaultMembershipSchema,
  WrappedDekSchema,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from './human-only.guard';
import { SecretManagerService } from './secret-manager.service';

/**
 * Create a vault (`POST /secret-vaults`) — the non-secret name + the creator's OWN first wrapped-DEK
 * membership (the DEK is client-generated, posted wrapped; ADR-0061 §3/§4). Composed here from the two
 * shared DTOs so the contract stays one source of truth and the service receives one cohesive body.
 */
const CreateVaultBodySchema = z.strictObject({
  name: CreateSecretVaultSchema.shape.name,
  membership: WrappedDekSchema,
});

class CreateVaultBodyDto extends createZodDto(CreateVaultBodySchema) {}
class UpdateSecretVaultDto extends createZodDto(UpdateSecretVaultSchema) {}
class SecretVaultDto extends createZodDto(SecretVaultSchema) {}
class CreateSecretItemDto extends createZodDto(CreateSecretItemSchema) {}
class UpdateSecretItemDto extends createZodDto(UpdateSecretItemSchema) {}
class SecretItemDto extends createZodDto(SecretItemSchema) {}
class CreateVaultMembershipDto extends createZodDto(
  CreateVaultMembershipSchema,
) {}
class VaultMembershipDto extends createZodDto(VaultMembershipSchema) {}

/**
 * Secret Manager — vaults, items, and members (ADR-0061). EVERY route is HUMAN-ONLY (`HumanOnlyGuard`)
 * and RBAC-gated (`@RequirePermission`). The TWO authorization layers (§7) combine here:
 *   - RBAC: `secret:read` for reads/item-CRUD, `secret:manage` for vault lifecycle + member grant/revoke.
 *   - Crypto membership: item + membership/me routes are additionally gated SERVER-SIDE on a LIVE
 *     {@link VaultMembership} for the caller (the service enforces it; a non-member gets 403/404). ADMIN
 *     sees vault/member METADATA without membership, but NEVER item envelopes or a wrapped DEK (INV-10).
 *
 * The grant route encodes the §4 NO-GRANT-WHAT-YOU-CANT-READ fence: even with `secret:manage`, the
 * granter must be a live member (the service refuses otherwise).
 *
 * `vaultId`/`itemId` are cuid (no built-in pipe — validated by existence in the service, 404 if missing,
 * scoped to prevent IDOR). `userId` path params are uuid (`ParseUUIDPipe`).
 */
@ApiTags('secret-manager')
@Controller('secret-vaults')
@UseGuards(HumanOnlyGuard)
export class VaultsController {
  constructor(private readonly secrets: SecretManagerService) {}

  // ── Vaults ──────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      'List vaults (ADMIN → all; else only vaults you are a live member of)',
  })
  @ApiOkResponse({ type: SecretVaultDto, isArray: true })
  list(@CurrentPrincipal() principal?: Principal) {
    return this.secrets.listVaults(principal);
  }

  @Post()
  @RequirePermission('secret:manage')
  @ApiOperation({
    summary:
      "Create a vault + the creator's first wrapped-DEK membership (one tx)",
  })
  @ApiOkResponse({ type: SecretVaultDto })
  create(
    @Body() dto: CreateVaultBodyDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.createVault(principal, {
      name: dto.name,
      membership: dto.membership,
    });
  }

  @Get(':vaultId')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary: 'Vault detail (name + member list; ADMIN or member)',
  })
  getOne(
    @Param('vaultId') vaultId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.getVault(principal, vaultId);
  }

  @Patch(':vaultId')
  @RequirePermission('secret:manage')
  @ApiOperation({ summary: 'Rename a vault' })
  @ApiOkResponse({ type: SecretVaultDto })
  rename(
    @Param('vaultId') vaultId: string,
    @Body() dto: UpdateSecretVaultDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.renameVault(principal, vaultId, dto);
  }

  @Delete(':vaultId')
  @RequirePermission('secret:manage')
  @ApiOperation({
    summary:
      'Soft-delete a vault (+ its items; hard-drop its memberships, one tx)',
  })
  @ApiOkResponse({ type: SecretVaultDto })
  remove(
    @Param('vaultId') vaultId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.deleteVault(principal, vaultId);
  }

  // ── Items ───────────────────────────────────────────────────────────────────

  @Get(':vaultId/items')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary: 'List items (envelope blobs; requires live membership)',
  })
  @ApiOkResponse({ type: SecretItemDto, isArray: true })
  listItems(
    @Param('vaultId') vaultId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.listItems(principal, vaultId);
  }

  @Post(':vaultId/items')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      'Add an item (client-encrypted envelope; live membership; 409 on handle collision)',
  })
  @ApiOkResponse({ type: SecretItemDto })
  createItem(
    @Param('vaultId') vaultId: string,
    @Body() dto: CreateSecretItemDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.createItem(principal, vaultId, dto);
  }

  @Patch(':vaultId/items/:itemId')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      'Update an item (re-encrypted envelope + label; envelope all-or-none)',
  })
  @ApiOkResponse({ type: SecretItemDto })
  updateItem(
    @Param('vaultId') vaultId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateSecretItemDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.updateItem(principal, vaultId, itemId, dto);
  }

  @Delete(':vaultId/items/:itemId')
  @RequirePermission('secret:read')
  @ApiOperation({ summary: 'Soft-delete an item (live membership)' })
  @ApiOkResponse({ type: SecretItemDto })
  removeItem(
    @Param('vaultId') vaultId: string,
    @Param('itemId') itemId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.deleteItem(principal, vaultId, itemId);
  }

  // ── Members ─────────────────────────────────────────────────────────────────

  @Get(':vaultId/members')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary: 'Member list (userId + display metadata; ADMIN or member)',
  })
  listMembers(
    @Param('vaultId') vaultId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.listMembers(principal, vaultId);
  }

  @Get(':vaultId/membership/me')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "The caller's own wrapped-DEK row for this vault (live membership; else 404)",
  })
  @ApiOkResponse({ type: VaultMembershipDto })
  myMembership(
    @Param('vaultId') vaultId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.getMyMembership(principal, vaultId);
  }

  @Post(':vaultId/members')
  @RequirePermission('secret:manage')
  @ApiOperation({
    summary:
      'GRANT a member (wrapped-DEK blob). Granter MUST be a live member (no-grant-what-you-cant-read).',
  })
  @ApiOkResponse({ type: VaultMembershipDto })
  grant(
    @Param('vaultId') vaultId: string,
    @Body() dto: CreateVaultMembershipDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.grantMembership(principal, vaultId, dto);
  }

  @Delete(':vaultId/members/:userId')
  @RequirePermission('secret:manage')
  @ApiOperation({ summary: 'REVOKE a member (hard-drop the wrapped-DEK row)' })
  revoke(
    @Param('vaultId') vaultId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.revokeMembership(principal, vaultId, userId);
  }
}
