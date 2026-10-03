import {
  BadRequestException,
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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  CreateSupplierSchema,
  SupplierListPageSchema,
  SupplierMergePreviewSchema,
  SupplierMergeResultSchema,
  SupplierMergeSchema,
  SupplierSchema,
  UpdateSupplierSchema,
} from '@lazyit/shared';
import { SuppliersService, SUPPLIER_SORT_ALLOWLIST } from './suppliers.service';
import { parsePageQuery } from '../common/parse-page-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

class SupplierDto extends createZodDto(SupplierSchema) {}
class SupplierListPageDto extends createZodDto(SupplierListPageSchema) {}
class CreateSupplierDto extends createZodDto(CreateSupplierSchema) {}
class UpdateSupplierDto extends createZodDto(UpdateSupplierSchema) {}
class SupplierMergeDto extends createZodDto(SupplierMergeSchema) {}
class SupplierMergePreviewDto extends createZodDto(
  SupplierMergePreviewSchema,
) {}
class SupplierMergeResultDto extends createZodDto(SupplierMergeResultSchema) {}

/**
 * Suppliers (ADR-0099 §2). Part of the Purchases permission domain: `purchaseOrder:read` to see them
 * (VIEWER denied by default), `:write` to create and edit, `:delete` (ADMIN) to archive, restore and merge.
 */
@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      'List suppliers (paginated; active by default). Server-side q search + sort. deleted=only lists archived rows (ADMIN).',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, tax ID and the sales / support contact names and emails',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(SUPPLIER_SORT_ALLOWLIST),
    description: 'Unknown field → 400. Default: name asc.',
  })
  @ApiQuery({ name: 'dir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description: 'only = archived rows — ADMIN only (403 otherwise).',
  })
  @ApiOkResponse({ type: SupplierListPageDto })
  findAll(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ) {
    const pageQuery = parsePageQuery({
      limit,
      offset,
      page,
      sort,
      dir,
      deleted,
    });
    assertCanListDeleted(pageQuery.deleted, user);
    return this.suppliers.findPage({ q }, pageQuery);
  }

  @Get(':id')
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({ summary: 'Get a supplier by id' })
  @ApiOkResponse({ type: SupplierDto })
  findOne(@Param('id') id: string) {
    return this.suppliers.findOne(id);
  }

  @Post()
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Create a supplier. Only the name is required; names and tax IDs are not unique.',
  })
  @ApiCreatedResponse({ type: SupplierDto })
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @Patch(':id')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({ summary: 'Update a supplier (null clears a field)' })
  @ApiOkResponse({ type: SupplierDto })
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('purchaseOrder:delete')
  @ApiOperation({
    summary:
      'Soft-delete a supplier — ADMIN only. Its purchases keep pointing at it.',
  })
  @ApiOkResponse({ type: SupplierDto })
  remove(@Param('id') id: string) {
    return this.suppliers.remove(id);
  }

  @Post(':id/restore')
  @RequirePermission('purchaseOrder:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted supplier — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: SupplierDto })
  restore(@Param('id') id: string) {
    return this.suppliers.restore(id);
  }

  @Get(':id/merge-preview')
  @RequirePermission('purchaseOrder:delete')
  @ApiOperation({
    summary:
      'Preview merging the duplicate sourceId into this supplier — ADMIN only. Writes nothing.',
  })
  @ApiQuery({ name: 'sourceId', required: true })
  @ApiOkResponse({ type: SupplierMergePreviewDto })
  @ApiBadRequestResponse({
    description: 'sourceId missing, malformed or equal to the id',
  })
  @ApiConflictResponse({ description: 'One of the two suppliers is archived' })
  mergePreview(@Param('id') id: string, @Query('sourceId') sourceId?: string) {
    const source = parseCuidQuery(sourceId, 'sourceId');
    if (source === undefined) {
      throw new BadRequestException('sourceId is required');
    }
    return this.suppliers.mergePreview(id, source);
  }

  @Post(':id/merge')
  @RequirePermission('purchaseOrder:delete')
  @ApiOperation({
    summary:
      'Merge the duplicate sourceId into this supplier — ADMIN only. Its purchases (archived ones included) move here, ' +
      "this supplier's empty fields are filled from it (nothing is overwritten), and the duplicate is archived.",
  })
  @ApiOkResponse({ type: SupplierMergeResultDto })
  @ApiBadRequestResponse({
    description: 'A supplier cannot be merged into itself',
  })
  @ApiConflictResponse({
    description: 'One of the two suppliers is archived (e.g. already merged)',
  })
  merge(
    @Param('id') id: string,
    @Body() dto: SupplierMergeDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.suppliers.merge(id, dto.sourceId, principal);
  }
}
