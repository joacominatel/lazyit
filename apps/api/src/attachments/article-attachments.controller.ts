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
import { ARTICLE_IMAGE_MAX_MB, AttachmentSchema } from '@lazyit/shared';
import { AttachmentsService } from './attachments.service';
import {
  attachmentsUploadStorage,
  contentDispositionFor,
} from './attachment-upload.storage';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

class AttachmentDto extends createZodDto(AttachmentSchema) {}

/**
 * Inline images on a KB Article (ADR-0082): png/jpg/gif/webp only, ≤ 10 MB, referenced from the
 * Markdown body as `![alt](attachment:<id>)`. Reads carry the article's FULL visibility gate (draft
 * privacy ADR-0022 + folder ACL ADR-0060 — 404, never 403); writes carry the article's edit gate
 * (author / ADMIN / `article:manage`). Raster blobs are re-encoded out-of-band (EXIF strip /
 * polyglot neutralization) by the sandboxed sharp processor.
 */
@ApiTags('articles')
@Controller('articles/:articleId/attachments')
export class ArticleAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Upload an inline image onto an article (multipart, single file) — ADR-0082. Raster images only (png/jpg/gif/webp, magic-byte sniffed — SVG/HTML rejected); ≤ 10 MB; 507 when the instance storage budget is full. Author, admins, or article:manage holders. (ADMIN or MEMBER)',
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
      limits: { fileSize: ARTICLE_IMAGE_MAX_MB * 1024 * 1024 },
    }),
  )
  upload(
    @Param('articleId') articleId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.upload('ARTICLE', articleId, file, principal);
  }

  @Get()
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      "List an article's live attachments (metadata only, newest first). 404 when the article itself isn't readable (missing, soft-deleted, a foreign draft, or folder-hidden).",
  })
  @ApiOkResponse({ type: [AttachmentDto] })
  list(
    @Param('articleId') articleId: string,
    @CurrentUser() user?: User,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.list('ARTICLE', articleId, user, principal);
  }

  @Get(':attachmentId/content')
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      "Stream an inline image's bytes (ADR-0082 §4): stored server-derived Content-Type, nosniff, CSP sandbox, Cache-Control private; Content-Disposition inline (raster images only). 404 (never 403) when the article/attachment is not accessible — a folder-hidden or foreign-draft article never leaks existence.",
  })
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('Cache-Control', 'private')
  async content(
    @Param('articleId') articleId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user?: User,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<StreamableFile> {
    const content = await this.attachments.getContent(
      'ARTICLE',
      articleId,
      attachmentId,
      user,
      principal,
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
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Soft-delete an attachment from an article (author, admins, or article:manage holders). The blob is reclaimed later by the GC sweep ONLY if no version snapshot references it (ADR-0082 §6). (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: AttachmentDto })
  remove(
    @Param('articleId') articleId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.attachments.remove(
      'ARTICLE',
      articleId,
      attachmentId,
      principal,
    );
  }
}
