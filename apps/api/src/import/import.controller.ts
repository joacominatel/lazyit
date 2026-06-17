import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ImportDryRunReportSchema,
  ImportEntitySchema,
  ImportMappingSchema,
  ImportResolutionPlanSchema,
  ImportSessionAcceptedSchema,
  ImportSessionViewSchema,
  ImportCommitResultSchema,
  type ImportEntity,
  type ImportMapping,
  type ImportResolutionPlan,
} from '@lazyit/shared';
import { ImportSessionService } from './import-session.service';
import { ImportDryRunService } from './dry-run.service';
import { ImportCommitService } from './import-commit.service';
import { detectImportFormat, maxImportBytes } from './import-upload';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { isServicePrincipal, type Principal } from '../auth/principal';

// Wire DTOs — the request bodies are validated by the global ZodValidationPipe against these shapes.
class ImportMappingDto extends createZodDto(ImportMappingSchema) {}
class ImportResolutionPlanDto extends createZodDto(ImportResolutionPlanSchema) {}
// Response envelopes (for OpenAPI).
class ImportSessionAcceptedDto extends createZodDto(ImportSessionAcceptedSchema) {}
class ImportSessionViewDto extends createZodDto(ImportSessionViewSchema) {}
class ImportDryRunReportDto extends createZodDto(ImportDryRunReportSchema) {}
class ImportCommitResultDto extends createZodDto(ImportCommitResultSchema) {}

/**
 * The guided bulk Migrator HTTP surface (ADR-0069 wave 4b, #635) — the wizard exposed over HTTP:
 * upload → status → map → dry-run → report → commit → result.
 *
 * AUTHORIZATION (the SENSITIVE wave — CEO-reviewed):
 *   - Every route is gated on the new coarse `import:run` permission (ADMIN-only by default,
 *     ADR-0069 §11). No `@Public` anywhere — adding the controller locks nothing open.
 *   - Every route is ALSO HUMAN-ONLY: the {@link ServicePrincipalForbiddenGuard} 403s any service
 *     account outright, regardless of its grants — import attributes real domain writes to a human
 *     operator and `import:run` must never be auto-grantable to a bot (mirrors the KB article-import
 *     human-only gate; ADR-0069 §2/§11).
 *   - Every session lookup is OWNER-SCOPED inside the service (the principal's `user.id` is passed as
 *     the owner): another operator's (or an unknown) session is 404, never readable — no IDOR.
 *   - The COMMIT additionally enforces a runtime per-target permission AND-check inside
 *     `ImportCommitService.enqueueCommit` (`asset:write` + the reference writes the frozen plan needs),
 *     which `@RequirePermission` can't express because the target isn't known until the plan exists.
 *
 * LOGGING stays PII-free (the framework logs route + status; this controller logs nothing of the
 * uploaded data). The actor is always derived from the principal — never a body/header field.
 */
@ApiTags('imports')
@Controller('imports')
@RequirePermission('import:run')
@UseGuards(ServicePrincipalForbiddenGuard)
export class ImportController {
  constructor(
    private readonly sessions: ImportSessionService,
    private readonly dryRun: ImportDryRunService,
    private readonly commits: ImportCommitService,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Upload a CSV/JSON file to start a bulk import — ASYNC (ADMIN, human-only). Validates type + size synchronously, creates an owner-scoped session, enqueues the sandboxed parse and returns 202 + a sessionId; poll GET /imports/:id for the detected shape + rows. (ADR-0069)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        entity: { type: 'string', enum: [...ImportEntitySchema.options] },
      },
    },
  })
  @ApiAcceptedResponse({ type: ImportSessionAcceptedDto })
  // Cap the upload at the interceptor (SEC-001) so multer aborts an over-cap stream early instead of
  // buffering an arbitrarily large file into the heap; platform-express maps multer's LIMIT_FILE_SIZE
  // to 413. The cap is fixed at boot from MAX_IMPORT_SIZE_MB (decoration-time eval). The parse itself
  // runs in the sandboxed, heap-capped child (SEC-002) — this cap does not bound that.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: maxImportBytes() } }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('entity') entityRaw: string | undefined,
    @CurrentPrincipal() principal?: Principal,
  ) {
    if (!file) {
      throw new BadRequestException('A file is required (multipart field "file").');
    }
    // Phase 1 targets Asset only; the field is accepted for forward-compatibility but validated against
    // the frozen enum (unknown value → 400).
    const entity: ImportEntity = entityRaw
      ? ImportEntitySchema.parse(entityRaw)
      : 'asset';
    const format = detectImportFormat(file.originalname);
    return this.sessions.createAndParse(this.ownerId(principal), entity, format, {
      originalname: file.originalname,
      buffer: file.buffer,
      size: file.size,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Poll an import session (owner-scoped): status, detected shape (headers/dialect/encoding/rowCount) and parsed rows. 404 for an unknown id or another owner\'s session. (ADR-0069)',
  })
  @ApiOkResponse({ type: ImportSessionViewDto })
  status(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.sessions.getForOwner(id, this.ownerId(principal));
  }

  @Post(':id/mapping')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Confirm the column/value/FK mapping for a PARSED session and advance it to MAPPED (owner-scoped). 409 if the session is not in a mappable status. (ADR-0069 §4)',
  })
  @ApiOkResponse({ type: ImportSessionViewDto })
  async setMapping(
    @Param('id') id: string,
    @Body() dto: ImportMappingDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const owner = this.ownerId(principal);
    await this.sessions.setMapping(id, owner, dto as unknown as ImportMapping);
    return this.sessions.getForOwner(id, owner);
  }

  @Post(':id/dry-run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Run the dry-run for a MAPPED session (owner-scoped) — WRITES NOTHING. Returns per-row outcomes, the deduped conflict set and the per-row asset-tag decisions for the operator to resolve. (ADR-0069 §5/§6/§7)',
  })
  @ApiOkResponse({ type: ImportDryRunReportDto })
  runDryRun(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.dryRun.dryRun(id, this.ownerId(principal));
  }

  @Post(':id/plan')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Freeze the operator's resolved conflict plan onto a session and advance it to DRY_RUN (owner-scoped). The plan is the immutable input the commit replays. (ADR-0069 §6)",
  })
  @ApiOkResponse({ type: ImportSessionViewDto })
  async savePlan(
    @Param('id') id: string,
    @Body() dto: ImportResolutionPlanDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const owner = this.ownerId(principal);
    await this.dryRun.saveResolutionPlan(
      id,
      owner,
      dto as unknown as ImportResolutionPlan,
    );
    return this.sessions.getForOwner(id, owner);
  }

  @Post(':id/commit')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Commit a DRY_RUN session — ASYNC (ADMIN, human-only, owner-scoped). Enqueues the chunked commit that replays the frozen plan; returns 202 + the sessionId. Beyond import:run, the actor must hold the write permission for every entity the plan creates (asset:write + the reference writes) — a runtime AND-check 403s a gap BEFORE any row is written (ADR-0069 §11). Poll GET /imports/:id/result. (ADR-0069 §8)',
  })
  @ApiAcceptedResponse({ type: ImportSessionAcceptedDto })
  commit(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.commits.enqueueCommit(id, this.ownerId(principal));
  }

  @Get(':id/result')
  @ApiOperation({
    summary:
      "Read the commit result of a session (owner-scoped): the status + the append-only ImportRun ledger counts once a commit produced one (null while still running). 404 for an unknown id or another owner's session. (ADR-0069 §9)",
  })
  @ApiOkResponse({ type: ImportCommitResultDto })
  result(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.commits.getCommitResult(id, this.ownerId(principal));
  }

  /**
   * The owner-scope key for every session lookup: the authenticated HUMAN's `User.id`. The
   * ServicePrincipalForbiddenGuard has already 403'd any service account before we get here, so a
   * present principal is a human; this is defence-in-depth (a missing/non-human principal → 400 rather
   * than a null owner that could widen a query). Import is human-only (ADR-0069 §2/§11).
   */
  private ownerId(principal?: Principal): string {
    if (!principal || isServicePrincipal(principal)) {
      throw new BadRequestException(
        'An authenticated human user is required for bulk import.',
      );
    }
    return principal.user.id;
  }
}
