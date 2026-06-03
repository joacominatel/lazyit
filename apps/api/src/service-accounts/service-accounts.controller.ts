import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  CreateServiceAccountSchema,
  ServiceAccountSchema,
  ServiceAccountWithSecretSchema,
  UpdateServiceAccountSchema,
} from '@lazyit/shared';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import { ServiceAccountsService } from './service-accounts.service';

// DTOs from the shared zod schemas (validation + TS type + OpenAPI). See ADR-0018.
class ServiceAccountDto extends createZodDto(ServiceAccountSchema) {}
class ServiceAccountWithSecretDto extends createZodDto(
  ServiceAccountWithSecretSchema,
) {}
class CreateServiceAccountDto extends createZodDto(
  CreateServiceAccountSchema,
) {}
class UpdateServiceAccountDto extends createZodDto(
  UpdateServiceAccountSchema,
) {}

/**
 * Service Accounts management API (ADR-0048). EVERY route is gated by `@RequirePermission('settings:manage')`
 * — the ADMIN-tier coarse capability (ADR-0046): only an admin manages service accounts. The controller
 * is thin; the {@link ServiceAccountsService} owns the token lifecycle + audit.
 *
 * SECRETS: `POST /` and `POST /:id/rotate` are the ONLY routes that ever return the cleartext token, and
 * each returns it EXACTLY ONCE (it is never persisted in cleartext and never recoverable). Every other
 * route returns the plain entity (tokenPrefix only — never the secret or the hash).
 */
@ApiTags('service-accounts')
@Controller('service-accounts')
export class ServiceAccountsController {
  constructor(private readonly serviceAccounts: ServiceAccountsService) {}

  @Post()
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary:
      'Create a service account + mint its token (ADMIN — settings:manage)',
    description:
      'Creates a non-human principal with the given name + direct permission grants and returns the ' +
      'full lazyit-native token (lzit_sa_<id>_<secret>) EXACTLY ONCE. Store it now — only its SHA-256 ' +
      'hash is persisted; the secret is never returned again. expiresAt (optional) must be in the future.',
  })
  @ApiCreatedResponse({ type: ServiceAccountWithSecretDto })
  create(@Body() dto: CreateServiceAccountDto, @CurrentUser() user?: User) {
    return this.serviceAccounts.create(dto, user?.id ?? null);
  }

  @Get()
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'List service accounts (ADMIN — settings:manage)',
    description:
      'Returns the service accounts (tokenPrefix, permissions, lastUsedAt, … — never the secret). ' +
      'Live by default; includeRevoked=true also lists revoked (soft-deleted) accounts.',
  })
  @ApiQuery({
    name: 'includeRevoked',
    required: false,
    type: Boolean,
    description: 'Include revoked (soft-deleted) accounts. Default false.',
  })
  @ApiOkResponse({ type: ServiceAccountDto, isArray: true })
  findAll(@Query('includeRevoked') includeRevoked?: string) {
    return this.serviceAccounts.findAll(
      parseBooleanQuery(includeRevoked) ?? false,
    );
  }

  @Get(':id')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'Get a service account by id (ADMIN — settings:manage)',
  })
  @ApiOkResponse({ type: ServiceAccountDto })
  findOne(@Param('id') id: string) {
    return this.serviceAccounts.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'Update a service account (ADMIN — settings:manage)',
    description:
      'Rename, edit the description, toggle isActive, change expiresAt (null clears it), and/or REPLACE ' +
      'the permission grant set wholesale. A grant change is audited (PERMISSION_CHANGE). The token is ' +
      'never touched here — use POST /:id/rotate to mint a new secret.',
  })
  @ApiOkResponse({ type: ServiceAccountDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateServiceAccountDto,
    @CurrentUser() user?: User,
  ) {
    return this.serviceAccounts.update(id, dto, user?.id ?? null);
  }

  @Post(':id/rotate')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'Rotate the token (ADMIN — settings:manage)',
    description:
      'Mints a NEW secret (the old token stops working immediately) and returns the new full token ' +
      'EXACTLY ONCE. The account id (and the token id segment) is unchanged.',
  })
  @ApiCreatedResponse({ type: ServiceAccountWithSecretDto })
  rotate(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.serviceAccounts.rotate(id, user?.id ?? null);
  }

  @Delete(':id')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'Revoke (soft-delete) a service account (ADMIN — settings:manage)',
    description:
      'Soft-deletes the account (= revoke): its token stops authenticating immediately. The row and ' +
      'its grants are preserved; POST /:id/restore brings it back. Audited (REVOKE).',
  })
  @ApiOkResponse({ type: ServiceAccountDto })
  remove(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.serviceAccounts.revoke(id, user?.id ?? null);
  }

  @Post(':id/restore')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'Restore a revoked service account (ADMIN — settings:manage)',
    description:
      'Clears the revocation (deletedAt). The EXISTING token resumes working — rotate separately to ' +
      'invalidate it. Idempotent if already live. Audited (RESTORE).',
  })
  @ApiOkResponse({ type: ServiceAccountDto })
  restore(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.serviceAccounts.restore(id, user?.id ?? null);
  }
}
