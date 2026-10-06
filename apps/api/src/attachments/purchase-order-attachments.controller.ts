import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ASSET_ATTACHMENT_MAX_MB,
  ATTACHMENT_LABEL_MAX_LENGTH,
  AttachmentSchema,
  UpdateAttachmentSchema,
} from '@lazyit/shared';
import { AttachmentsService } from './attachments.service';
import {
  attachmentsUploadStorage,
  contentDispositionFor,
} from './attachment-upload.storage';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';

class AttachmentDto extends createZodDto(AttachmentSchema) {}
class UpdateAttachmentDto extends createZodDto(UpdateAttachmentSchema) {}

/**
 * A purchase's documents (ADR-0099 §10, ADR-0082): quote, order, invoice, delivery note — the ASSET
 * documents allowlist and cap (pdf/png/jpg/webp/gif/txt/csv/docx/xlsx, ≤ 25 MB each). Gated on
 * `purchaseOrder:read` / `purchaseOrder:write`; the same rows are what an asset linked to the purchase lists
 * (`GET /assets/:id/purchase`, same permission), downloaded through this controller. Content is served
 * API-origin-only with hardened headers (§4). Adding or removing a document is logged on the purchase.
 */
@ApiTags('purchase-orders')
@Controller('purchase-orders/:purchaseOrderId/attachments')
export class PurchaseOrderAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Upload a document onto a purchase (multipart, single file) — ADR-0099 §10 / ADR-0082. Type is decided by magic-byte sniff (never the client MIME/extension); SVG/HTML rejected; ≤ 25 MB; 507 when the instance storage budget is full. Logged as DOCUMENT_ADDED. Human callers only.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        label: {
          type: 'string',
          maxLength: ATTACHMENT_LABEL_MAX_LENGTH,
          description:
            'Optional document type label (quote, invoice, delivery note…); blank = none.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AttachmentDto })
  // diskStorage to attachments/tmp (NEVER memoryStorage — ADR-0082 red line) + the hard multer cap
  // so an oversized stream aborts early (413) instead of filling the disk; the service re-checks.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: attachmentsUploadStorage(),
      limits: { fileSize: ASSET_ATTACHMENT_MAX_MB * 1024 * 1024 },
    }),
  )
  upload(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('label') label?: unknown,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.upload(
      'PURCHASE_ORDER',
      purchaseOrderId,
      file,
      principal,
      label,
    );
  }

  @Get()
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      "List a purchase's live documents (metadata only, newest first) — 404 for a missing/archived purchase.",
  })
  @ApiOkResponse({ type: [AttachmentDto] })
  list(@Param('purchaseOrderId') purchaseOrderId: string) {
    return this.attachments.list('PURCHASE_ORDER', purchaseOrderId);
  }

  @Get(':attachmentId/content')
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      "Stream an attachment's bytes (ADR-0082 §4): stored server-derived Content-Type, nosniff, CSP sandbox, Cache-Control private; Content-Disposition attachment for documents / inline only for raster images. 404 when the purchase/attachment is not accessible.",
  })
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('Cache-Control', 'private')
  async content(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<StreamableFile> {
    const content = await this.attachments.getContent(
      'PURCHASE_ORDER',
      purchaseOrderId,
      attachmentId,
    );
    return new StreamableFile(content.stream, {
      type: content.mimeType,
      length: content.byteSize,
      disposition: contentDispositionFor(
        content.mimeType,
        content.originalName,
      ),
    });
  }

  @Patch(':attachmentId')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      "Set or clear a document's type label (null clears it). Only the label is editable. Logged as DOCUMENT_UPDATED. Human callers only.",
  })
  @ApiOkResponse({ type: AttachmentDto })
  updateLabel(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: UpdateAttachmentDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.updateLabel(
      'PURCHASE_ORDER',
      purchaseOrderId,
      attachmentId,
      dto.label,
      principal,
    );
  }

  @Delete(':attachmentId')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Soft-delete a document from a purchase (the blob is reclaimed later by the GC sweep, never inline — ADR-0082 §6). Logged as DOCUMENT_REMOVED. Human callers only.',
  })
  @ApiOkResponse({ type: AttachmentDto })
  remove(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.remove(
      'PURCHASE_ORDER',
      purchaseOrderId,
      attachmentId,
      principal,
    );
  }
}
