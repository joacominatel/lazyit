import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ChangeKeypairPasswordSchema,
  CreateUserKeypairSchema,
  ResetUserKeypairSchema,
  UserKeypairSchema,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import { HumanOnlyGuard } from './human-only.guard';
import { SecretManagerService } from './secret-manager.service';

class UserKeypairDto extends createZodDto(UserKeypairSchema) {}
class CreateUserKeypairDto extends createZodDto(CreateUserKeypairSchema) {}
class ResetUserKeypairDto extends createZodDto(ResetUserKeypairSchema) {}
class ChangeKeypairPasswordDto extends createZodDto(
  ChangeKeypairPasswordSchema,
) {}

/**
 * Secret Manager — keypair surface (ADR-0061 §3). The per-user X25519 envelope the whole zero-knowledge
 * scheme wraps DEKs to. EVERY route requires `secret:read` (the RBAC entry gate) and is HUMAN-ONLY
 * (`HumanOnlyGuard` — a service account has no keypair, INV-SA spirit). All material is CLIENT-GENERATED;
 * the server stores public + wrapped blobs only and can NEVER reconstruct a private key (INV-10).
 *
 * `keypair/me` is self-only by construction (the userId is the authenticated caller). `users/:userId/
 * public-key` exposes ONLY a public key (the material a granter wraps a DEK to) — never a wrapped private
 * key.
 */
@ApiTags('secret-manager')
@Controller('secret-manager')
@UseGuards(HumanOnlyGuard)
export class KeypairController {
  constructor(private readonly secrets: SecretManagerService) {}

  @Get('keypair/me')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary: "The caller's own keypair (public + wrapped private copies)",
  })
  @ApiOkResponse({ type: UserKeypairDto })
  getMine(@CurrentPrincipal() principal?: Principal) {
    return this.secrets.getMyKeypair(principal);
  }

  @Post('keypair')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "Bootstrap the caller's keypair (client-generated; 409 if one exists)",
  })
  @ApiOkResponse({ type: UserKeypairDto })
  create(
    @Body() dto: CreateUserKeypairDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.createMyKeypair(principal, dto);
  }

  @Put('keypair/me')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "Reset / replace the caller's keypair (peer-reset / passphrase change)",
  })
  @ApiOkResponse({ type: UserKeypairDto })
  reset(
    @Body() dto: ResetUserKeypairDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.resetMyKeypair(principal, dto);
  }

  @Post('keypair/password')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "Change/reset ONLY the caller's password wrap (Copy A). Re-wraps the private key under a new password (unlocked client-side via the current password OR the recovery key). Public key + recovery wrap unchanged; 404 if none.",
  })
  @ApiOkResponse({ type: UserKeypairDto })
  changePassword(
    @Body() dto: ChangeKeypairPasswordDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.secrets.changePassword(principal, dto);
  }

  @Get('users/:userId/public-key')
  @RequirePermission('secret:read')
  @ApiOperation({
    summary:
      "A user's PUBLIC key (to wrap a DEK to when granting). Public material only.",
  })
  publicKey(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.secrets.getUserPublicKey(userId);
  }
}
