import {
  Controller,
  Delete,
  Get,
  Header,
  Param,
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
import { ASSET_ATTACHMENT_MAX_MB, AttachmentSchema } from '@lazyit/shared';
import { AttachmentsService } from './attachments.service';
import {
  attachmentsUploadStorage,
  contentDispositionFor,
} from './attachment-upload.storage';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';

class AttachmentDto extends createZodDto(AttachmentSchema) {}

/**
 * Documents on an Asset (ADR-0082): warranty PDFs, receipts, damage photos — pdf/png/jpg/webp/gif/
 * txt/csv/docx/xlsx, ≤ 25 MB each. Gated on the PARENT's capability (`asset:read` / `asset:write`);
 * content is served API-origin-only with hardened headers (§4) — NEVER through the web proxy's
 * public media-extension bypass (red line).
 */
@ApiTags('assets')
@Controller('assets/:assetId/attachments')
export class AssetAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @RequirePermission('asset:write')
  @ApiOperation({
    summary:
      'Upload a document onto an asset (multipart, single file) — ADR-0082. Type is decided by magic-byte sniff (never the client MIME/extension); SVG/HTML rejected; ≤ 25 MB; 507 when the instance storage budget is full. (ADMIN or MEMBER)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
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
    @Param('assetId') assetId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.upload('ASSET', assetId, file, principal);
  }

  @Get()
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      "List an asset's live attachments (metadata only, newest first) — 404 for a missing/deleted asset.",
  })
  @ApiOkResponse({ type: [AttachmentDto] })
  list(@Param('assetId') assetId: string) {
    return this.attachments.list('ASSET', assetId);
  }

  @Get(':attachmentId/content')
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      "Stream an attachment's bytes (ADR-0082 §4): stored server-derived Content-Type, nosniff, CSP sandbox, Cache-Control private; Content-Disposition attachment for documents / inline only for raster images. 404 (never 403) when the asset/attachment is not accessible.",
  })
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('Cache-Control', 'private')
  async content(
    @Param('assetId') assetId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<StreamableFile> {
    const content = await this.attachments.getContent(
      'ASSET',
      assetId,
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

  @Delete(':attachmentId')
  @RequirePermission('asset:write')
  @ApiOperation({
    summary:
      'Soft-delete an attachment from an asset (the blob is reclaimed later by the GC sweep, never inline — ADR-0082 §6). (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: AttachmentDto })
  remove(
    @Param('assetId') assetId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.remove('ASSET', assetId, attachmentId, principal);
  }
}
