import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  CreateServiceAccountKeypairSchema,
  ServiceAccountKeypairSchema,
  ServiceAccountPublicKeySchema,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from './human-only.guard';
import { SecretManagerService } from './secret-manager.service';

class CreateServiceAccountKeypairDto extends createZodDto(
  CreateServiceAccountKeypairSchema,
) {}
class ServiceAccountKeypairDto extends createZodDto(
  ServiceAccountKeypairSchema,
) {}
class ServiceAccountPublicKeyDto extends createZodDto(
  ServiceAccountPublicKeySchema,
) {}

/**
 * Secret Manager — SERVICE ACCOUNT keypair surface (ADR-0080, programmatic secret retrieval). The MACHINE
 * twin of the human {@link KeypairController}, but these routes are HUMAN-ONLY (`HumanOnlyGuard`): a
 * service account cannot bootstrap its OWN crypto identity, so a HUMAN ADMIN (`secret:manage`) uploads the
 * client-generated material during SA creation. All material is CLIENT-GENERATED; the server stores public
 * + wrapped blobs only and can NEVER reconstruct a private key or the token (INV-10).
 *
 * `saId` is a cuid (no `ParseUUIDPipe`) — validated by existence in the service (404 if missing). The
 * public-key route exposes ONLY the SA's public key (the material a granter wraps a DEK to), never a
 * wrapped private-key blob.
 */
@ApiTags('secret-manager')
@Controller('secret-manager/service-accounts')
@UseGuards(HumanOnlyGuard)
export class ServiceAccountKeypairController {
  constructor(private readonly secrets: SecretManagerService) {}

  @Post(':saId/keypair')
  @RequirePermission('secret:manage')
  @ApiOperation({
    summary:
      "Bootstrap a service account's keypair (client-generated, token-wrapped; 409 if one exists)",
  })
  @ApiOkResponse({ type: ServiceAccountKeypairDto })
  bootstrapKeypair(
    @Param('saId') saId: string,
    @Body() dto: CreateServiceAccountKeypairDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.bootstrapServiceAccountKeypair(principal, saId, dto);
  }

  @Get(':saId/public-key')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "A service account's PUBLIC key (to wrap a DEK to when granting). Public material only.",
  })
  @ApiOkResponse({ type: ServiceAccountPublicKeyDto })
  publicKey(@Param('saId') saId: string) {
    return this.secrets.getServiceAccountPublicKey(saId);
  }
}
