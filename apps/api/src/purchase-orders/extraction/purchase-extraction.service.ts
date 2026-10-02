import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AI_DOCUMENT_EXTRACTION_DISCLOSURE,
  AI_PROVIDER_DESCRIPTORS,
  PURCHASE_EXTRACTION_MAX_BYTES,
  PURCHASE_EXTRACTION_MAX_PAGES,
  aiDocumentExtractionMaxBytes,
  aiDocumentExtractionMediaTypes,
  type AiProviderKind,
  type AiUsage,
  type Permission,
  type PurchaseExtractionDraft,
  type PurchaseExtractionMatches,
  type PurchaseExtractionStatus,
  type PurchaseExtractionUnavailableReason,
} from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../../common/actor.service';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { isHumanPrincipal, type Principal } from '../../auth/principal';
import { blobPathFor } from '../../attachments/attachment-storage';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
  type ResolvedAiProviderConfig,
} from '../../ai/core/ports/ai-settings.port';
import {
  STRUCTURED_EXTRACTION_PORT,
  type StructuredExtractionPort,
} from '../../ai/core/ports/structured-extraction.port';
import {
  AiProviderError,
  AiStructuredOutputError,
} from '../../ai/providers/ai-provider.error';
import { AiRunLimits, TokenBucket, clampInt4 } from '../../ai/runtime/limits';
import { describeError } from '../../ai/runtime/runtime.constants';
import { recordPurchaseOrderEvent } from '../purchase-order-events';
import { buildDraft, extractionLineLimit, type DraftContext } from './draft';
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_SCHEMA_NAME,
  ExtractionModelOutputSchema,
  extractionPrompt,
  type ExtractionModelOutput,
} from './extraction-model';
import {
  compactText,
  normalizeCompanyName,
  normalizeTaxId,
  uniqueMatch,
} from './matching';

/** How long one extraction may take, connect to last byte, before it is abandoned (nothing saved). */
export const PURCHASE_EXTRACTION_TIMEOUT_MS = 120_000;
/** The output ceiling of one extraction: a long invoice's lines with their evidence, not more. */
export const PURCHASE_EXTRACTION_MAX_OUTPUT_TOKENS = 16_000;
/** What a caller needs to extract (the route checks both; the status read reports them per caller). */
const EXTRACT_PERMISSIONS: readonly Permission[] = [
  'purchaseOrder:write',
  'ai:use',
];
/** Upper bound on the records read for the suggestions (small-team instances hold far fewer). */
const MATCH_READ_LIMIT = 10_000;
/**
 * Extractions a person may START per minute (a token bucket), on top of one in flight at a time. A person
 * reviews each draft, so a handful a minute is generous; a loop or a stuck double-click is not.
 */
export const PURCHASE_EXTRACTIONS_PER_MINUTE = 5;

/** The effective size cap of one document: the extraction cap, or the provider's lower one for its type. */
function maxBytesFor(provider: AiProviderKind, mediaType: string): number {
  return Math.min(
    PURCHASE_EXTRACTION_MAX_BYTES,
    aiDocumentExtractionMaxBytes(provider, mediaType) ??
      PURCHASE_EXTRACTION_MAX_BYTES,
  );
}

type Capability =
  | {
      ok: true;
      config: ResolvedAiProviderConfig;
      mediaTypes: readonly string[];
      dailyTokenLimit: number | null;
      maxOutputTokens: number;
    }
  | { ok: false; reason: PurchaseExtractionUnavailableReason };

/** A refusal body the web matches on `code` (the AI settings pattern). */
function refusal(
  status: HttpStatus,
  // A `PurchaseExtractionErrorCode`, or a provider code passed through (`PROVIDER_*`, `EGRESS_DENIED`, …).
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}

const UNAVAILABLE_MESSAGES: Record<
  PurchaseExtractionUnavailableReason,
  string
> = {
  AI_DISABLED: 'The AI assistant is not enabled or not configured.',
  EXTRACTION_DISABLED:
    'Document extraction is off. An admin can turn it on in Settings → AI.',
  PROVIDER_UNSUPPORTED:
    'The configured AI provider cannot read documents for extraction.',
  NOT_PERMITTED: 'You may not extract purchase documents.',
};

/**
 * What an extraction says for a provider failure where the chat's wording would mislead (it speaks of a
 * conversation); the others keep the provider error's own message.
 */
const PROVIDER_FAILURE_MESSAGES: Partial<Record<string, string>> = {
  CONTEXT_LIMIT:
    'The document is too long for the configured model. Nothing was filled.',
  PROVIDER_BAD_REQUEST:
    'The AI provider could not read this document (the configured model may not accept files). Nothing was filled.',
  CANCELLED: 'The extraction was cancelled. Nothing was filled.',
};

/**
 * The PDF pages, counted best-effort from the page objects the file declares (`/Type /Page`). A PDF that
 * keeps its objects in compressed streams counts 0 here and is let through: the provider's own page limit
 * still applies, and the byte cap bounds it.
 */
export function countPdfPages(bytes: Buffer): number {
  return (bytes.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? [])
    .length;
}

/**
 * Purchase document extraction (ADR-0099 §11, #1477): read a document ALREADY ATTACHED to a purchase through
 * the configured AI provider and return a DRAFT for a person to review. It never saves anything to the
 * purchase, its lines, suppliers or models — it writes only the usage row (the token budget) and the
 * purchase's `EXTRACTION_RUN` event (metadata, no content), because a document left the instance.
 *
 * Gates, in order: a human caller (service accounts are refused — extraction is a reviewed, interactive
 * step), the capability (assistant usable, the switch on, a provider that reads documents), the document
 * (live purchase and attachment, a readable type, the size and page caps), then the caller's daily token
 * budget. The model call has no tools and a timeout; amounts and dates are read by lazyit from the printed
 * text; suppliers and models are suggested, never created.
 */
@Injectable()
export class PurchaseExtractionService {
  private readonly logger = new Logger(PurchaseExtractionService.name);
  /**
   * The extraction's own limiters, not the chat's (ADR-0099, decisions while building Phase 2): in memory,
   * per API process (one per install — the chat's posture), keyed by user. The token BUDGET is the one
   * shared with chat: it is persisted, read from `ai_usage`.
   */
  private readonly inFlight = new Set<string>();
  private readonly rate = new TokenBucket(
    PURCHASE_EXTRACTIONS_PER_MINUTE,
    60_000,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly permissions: PermissionResolverService,
    private readonly limits: AiRunLimits,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    @Inject(STRUCTURED_EXTRACTION_PORT)
    private readonly model: StructuredExtractionPort,
  ) {}

  /** `GET /purchase-orders/extraction/status` — whether the caller can extract now, which types, how big. */
  async status(principal?: Principal): Promise<PurchaseExtractionStatus> {
    const base = {
      maxBytes: PURCHASE_EXTRACTION_MAX_BYTES,
      maxPages: PURCHASE_EXTRACTION_MAX_PAGES,
      disclosure: AI_DOCUMENT_EXTRACTION_DISCLOSURE,
    };
    const capability = await this.capability();
    const reason = !capability.ok
      ? capability.reason
      : (await this.permitted(principal))
        ? null
        : 'NOT_PERMITTED';
    if (reason !== null || !capability.ok) {
      return {
        available: false,
        reason,
        mediaTypes: [],
        maxBytesByMediaType: {},
        ...base,
      };
    }
    return {
      available: true,
      reason: null,
      mediaTypes: [...capability.mediaTypes],
      maxBytesByMediaType: Object.fromEntries(
        capability.mediaTypes.map((type) => [
          type,
          maxBytesFor(capability.config.provider, type),
        ]),
      ),
      ...base,
    };
  }

  /**
   * `POST /purchase-orders/:id/attachments/:attachmentId/extract` — the draft. Refusals carry a `code`
   * (`PURCHASE_EXTRACTION_ERROR_CODES`); nothing is saved on any of them.
   */
  async extract(
    purchaseOrderId: string,
    attachmentId: string,
    principal?: Principal,
  ): Promise<PurchaseExtractionDraft> {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException(
        'Document extraction is for people: a service account cannot send documents to the AI provider',
      );
    }
    const capability = await this.capability();
    if (!capability.ok) {
      throw refusal(
        HttpStatus.CONFLICT,
        capability.reason,
        UNAVAILABLE_MESSAGES[capability.reason],
      );
    }
    const userId = principal.user.id;
    // One extraction in flight per person (checked and taken synchronously, so two requests cannot both pass).
    if (this.inFlight.has(userId)) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'EXTRACTION_IN_PROGRESS',
        'An extraction of yours is already running; wait for it to finish',
      );
    }
    this.inFlight.add(userId);
    try {
      return await this.run(
        purchaseOrderId,
        attachmentId,
        principal,
        capability,
      );
    } finally {
      this.inFlight.delete(userId);
    }
  }

  private async run(
    purchaseOrderId: string,
    attachmentId: string,
    principal: Principal & { kind: 'human' },
    capability: Extract<Capability, { ok: true }>,
  ): Promise<PurchaseExtractionDraft> {
    const document = await this.loadDocument(
      purchaseOrderId,
      attachmentId,
      capability.config.provider,
      capability.mediaTypes,
    );
    const userId = principal.user.id;
    if (
      await this.limits.budgetExceeded({ userId }, capability.dailyTokenLimit)
    ) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'BUDGET_EXCEEDED',
        'Your daily AI token budget is spent',
      );
    }
    // Taken last, so a refused document or a spent budget costs no attempt.
    if (!this.rate.take(userId)) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        `At most ${PURCHASE_EXTRACTIONS_PER_MINUTE} extractions a minute`,
        { retryAfterSec: this.rate.retryAfterSec(userId) },
      );
    }

    const context: DraftContext = {
      extractionId: `ext_${randomUUID()}`,
      purchaseOrderId,
      attachmentId,
    };
    const { provider, model } = capability.config;
    const maxLines = extractionLineLimit(capability.maxOutputTokens);
    const started = Date.now();
    const signal = AbortSignal.timeout(PURCHASE_EXTRACTION_TIMEOUT_MS);
    let output: ExtractionModelOutput;
    let usage: AiUsage;
    try {
      const result = await this.model.extractStructured({
        model: { provider, modelId: model },
        instructions: EXTRACTION_INSTRUCTIONS,
        prompt: extractionPrompt(maxLines),
        file: { data: document.bytes, mediaType: document.mediaType },
        schema: ExtractionModelOutputSchema,
        schemaName: EXTRACTION_SCHEMA_NAME,
        maxOutputTokens: capability.maxOutputTokens,
        abortSignal: signal,
      });
      output = result.output;
      usage = result.usage;
    } catch (err) {
      const failure = this.failureOf(err, signal);
      // Only a call that may have reached the provider is a document that left the instance.
      if (failure.sent) {
        await this.record(principal, context, capability.config, {
          outcome: 'FAILED',
          errorCode: failure.code,
          usage: err instanceof AiStructuredOutputError ? err.usage : null,
        });
      }
      this.logFinish(context, capability.config, started, {
        outcome: 'FAILED',
        errorCode: failure.code,
        sent: failure.sent ? 1 : 0,
      });
      throw failure.exception;
    }

    const draft = buildDraft(output, context, maxLines);
    const matches = await this.matchesFor(draft);
    await this.record(principal, context, capability.config, {
      outcome: 'SUCCEEDED',
      errorCode: null,
      usage,
      lineCount: draft.lines.length,
      warningCount: draft.warnings.length,
    });
    this.logFinish(context, capability.config, started, {
      outcome: 'SUCCEEDED',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      lineCount: draft.lines.length,
      warningCount: draft.warnings.length,
    });
    return { ...draft, matches };
  }

  // ── Gates ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether extraction can run on this instance now: the assistant usable exactly as the chat checks it
   * (enabled, configured, its key decrypting, not shim mode — `resolveProviderConfig` — and a key where the
   * provider needs one), the *Document extraction* switch on, and a provider that reads documents.
   */
  private async capability(): Promise<Capability> {
    const config = await this.settings.resolveProviderConfig();
    if (
      !config ||
      (config.apiKey === null &&
        AI_PROVIDER_DESCRIPTORS[config.provider].requiresApiKey)
    ) {
      return { ok: false, reason: 'AI_DISABLED' };
    }
    const settings = await this.settings.getSettings();
    if (!settings.documentExtractionEnabled) {
      return { ok: false, reason: 'EXTRACTION_DISABLED' };
    }
    const mediaTypes = aiDocumentExtractionMediaTypes(config.provider);
    if (mediaTypes.length === 0) {
      return { ok: false, reason: 'PROVIDER_UNSUPPORTED' };
    }
    return {
      ok: true,
      config,
      mediaTypes,
      dailyTokenLimit: settings.dailyTokenLimitPerPrincipal,
      maxOutputTokens: Math.min(
        settings.maxOutputTokens,
        PURCHASE_EXTRACTION_MAX_OUTPUT_TOKENS,
      ),
    };
  }

  /** A human holding every permission the extract route requires (resolved DB-first, as the guard does). */
  private async permitted(principal?: Principal): Promise<boolean> {
    if (!isHumanPrincipal(principal)) return false;
    const held = await this.permissions.resolve(principal.user.role);
    return EXTRACT_PERMISSIONS.every((permission) => held.has(permission));
  }

  /**
   * The document's bytes: a live attachment of this live purchase (404 otherwise — as the documents
   * routes answer), of a type the provider reads, within the size cap for that provider and type and the
   * page cap (422). All checked here, before anything is sent.
   */
  private async loadDocument(
    purchaseOrderId: string,
    attachmentId: string,
    provider: AiProviderKind,
    mediaTypes: readonly string[],
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    const purchase = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, deletedAt: null },
      select: { id: true },
    });
    if (!purchase) {
      throw new NotFoundException(`Purchase ${purchaseOrderId} not found`);
    }
    const row = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        entityType: 'PURCHASE_ORDER',
        entityId: purchaseOrderId,
      },
      select: { mimeType: true, sha256: true },
    });
    if (!row) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    if (!mediaTypes.includes(row.mimeType)) {
      throw refusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'UNSUPPORTED_MEDIA_TYPE',
        `The configured AI provider cannot read ${row.mimeType} documents; it reads ${mediaTypes.join(', ')}`,
      );
    }
    const path = blobPathFor(row.sha256);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw refusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DOCUMENT_UNAVAILABLE',
        'The stored file of this document is missing',
      );
    }
    const maxBytes = maxBytesFor(provider, row.mimeType);
    if (size > maxBytes) {
      throw refusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DOCUMENT_TOO_LARGE',
        `The configured AI provider reads ${row.mimeType} documents up to ${(maxBytes / (1024 * 1024)).toFixed(1)} MB`,
        { maxBytes },
      );
    }
    const bytes = await readFile(path);
    if (
      row.mimeType === 'application/pdf' &&
      countPdfPages(bytes) > PURCHASE_EXTRACTION_MAX_PAGES
    ) {
      throw refusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'TOO_MANY_PAGES',
        `Documents longer than ${PURCHASE_EXTRACTION_MAX_PAGES} pages are not sent for extraction`,
      );
    }
    return { bytes, mediaType: row.mimeType };
  }

  // ── Suggestions ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Read-only suggestions (`PurchaseExtractionMatches`): the supplier by tax ID, else by normalized name;
   * each line's model by an earlier line with the same description, else by brand and model text. A match
   * must be unique; nothing is created.
   */
  private async matchesFor(
    draft: Omit<PurchaseExtractionDraft, 'matches'>,
  ): Promise<PurchaseExtractionMatches> {
    return {
      supplier: await this.matchSupplier(draft),
      lineModels: await this.matchModels(draft),
    };
  }

  private async matchSupplier(
    draft: Omit<PurchaseExtractionDraft, 'matches'>,
  ): Promise<PurchaseExtractionMatches['supplier']> {
    const taxId = draft.header.supplierTaxId.value
      ? normalizeTaxId(draft.header.supplierTaxId.value)
      : null;
    const name = draft.header.supplierName.value
      ? normalizeCompanyName(draft.header.supplierName.value)
      : '';
    if (!taxId && !name) return null;
    const suppliers = await this.prisma.supplier.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, taxId: true },
      take: MATCH_READ_LIMIT,
    });
    if (taxId) {
      const byTaxId = uniqueMatch(
        suppliers,
        (s) => s.taxId !== null && normalizeTaxId(s.taxId) === taxId,
      );
      if (byTaxId) return { id: byTaxId.id, name: byTaxId.name, by: 'TAX_ID' };
    }
    if (name) {
      const byName = uniqueMatch(
        suppliers,
        (s) => normalizeCompanyName(s.name) === name,
      );
      if (byName) return { id: byName.id, name: byName.name, by: 'NAME' };
    }
    return null;
  }

  private async matchModels(
    draft: Omit<PurchaseExtractionDraft, 'matches'>,
  ): Promise<PurchaseExtractionMatches['lineModels']> {
    // Asset models are offered for lines that may be devices: ASSET, or a kind the model could not tell.
    const wanted = draft.lines.map((line) =>
      line.kind === null || line.kind === 'ASSET' ? line : null,
    );
    if (wanted.every((line) => line === null)) {
      return draft.lines.map(() => null);
    }
    const descriptions = [
      ...new Set(
        wanted
          .map((line) => line?.description.value?.trim())
          .filter((d): d is string => !!d),
      ),
    ];
    const memory =
      descriptions.length === 0
        ? []
        : await this.prisma.purchaseOrderLine.findMany({
            where: {
              deletedAt: null,
              assetModelId: { not: null },
              assetModel: { deletedAt: null },
              OR: descriptions.map((description) => ({
                description: { equals: description, mode: 'insensitive' },
              })),
            },
            select: {
              description: true,
              assetModel: {
                select: { id: true, name: true, manufacturer: true },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: MATCH_READ_LIMIT,
          });
    const remembered = new Map<
      string,
      { id: string; name: string; manufacturer: string }
    >();
    for (const row of memory) {
      const key = row.description.trim().toLowerCase();
      // Newest first: the most recent mapping of a description wins.
      if (row.assetModel && !remembered.has(key)) {
        remembered.set(key, row.assetModel);
      }
    }
    const needsName = wanted.some(
      (line) =>
        line?.modelText.value &&
        !remembered.has(line.description.value?.trim().toLowerCase() ?? ''),
    );
    const models = needsName
      ? await this.prisma.assetModel.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, manufacturer: true },
          take: MATCH_READ_LIMIT,
        })
      : [];
    return wanted.map((line) => {
      if (!line) return null;
      const fromMemory = remembered.get(
        line.description.value?.trim().toLowerCase() ?? '',
      );
      if (fromMemory) return { ...fromMemory, by: 'LINE_MEMORY' as const };
      if (!line.modelText.value) return null;
      const modelText = compactText(line.modelText.value);
      const brand = line.manufacturerText.value
        ? compactText(line.manufacturerText.value)
        : null;
      const found = uniqueMatch(
        models,
        (m) =>
          compactText(m.name) === modelText &&
          (brand === null || compactText(m.manufacturer) === brand),
      );
      return found ? { ...found, by: 'NAME' as const } : null;
    });
  }

  // ── Records ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The usage row (counted against the caller's rolling token budget; `runId` is the extraction id) and the
   * purchase's `EXTRACTION_RUN` event, in one transaction. Metadata only: no value read from the document.
   */
  private async record(
    principal: Principal,
    context: DraftContext,
    config: ResolvedAiProviderConfig,
    result: {
      outcome: 'SUCCEEDED' | 'FAILED';
      errorCode: string | null;
      usage: AiUsage | null;
      lineCount?: number;
      warningCount?: number;
    },
  ): Promise<void> {
    const actor = this.actor.resolveActor(principal);
    await this.prisma.$transaction(async (tx) => {
      if (result.usage) {
        await tx.aiUsage.create({
          data: {
            runId: context.extractionId,
            userId: actor.userId ?? null,
            serviceAccountId: null,
            provider: config.provider,
            model: config.model,
            inputTokens: clampInt4(result.usage.inputTokens),
            outputTokens: clampInt4(result.usage.outputTokens),
            cachedInputTokens: clampInt4(result.usage.cachedInputTokens),
            reasoningTokens:
              result.usage.reasoningTokens === undefined
                ? null
                : clampInt4(result.usage.reasoningTokens),
          },
        });
      }
      await recordPurchaseOrderEvent(
        tx,
        context.purchaseOrderId,
        'EXTRACTION_RUN',
        actor,
        {
          extractionId: context.extractionId,
          attachmentId: context.attachmentId,
          outcome: result.outcome,
          errorCode: result.errorCode,
          provider: config.provider,
          model: config.model,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          lineCount: result.lineCount ?? null,
          warningCount: result.warningCount ?? null,
        },
      );
    });
  }

  /** One log line per extraction: ids, provider, timing and counts — never document content (ADR-0031). */
  private logFinish(
    context: DraftContext,
    config: ResolvedAiProviderConfig,
    started: number,
    detail: Record<string, string | number | null>,
  ): void {
    this.logger.log({
      event: 'ai.extraction.finish',
      extractionId: context.extractionId,
      purchaseOrderId: context.purchaseOrderId,
      attachmentId: context.attachmentId,
      provider: config.provider,
      model: config.model,
      latencyMs: Date.now() - started,
      ...detail,
    });
  }

  /**
   * A failed model call → its code, the HTTP refusal (no provider body, no document text) and whether the
   * document may have reached the provider. It did NOT when the call failed before any I/O: the configuration
   * moved since the capability check (`AI_DISABLED`, `CONVERSATION_READ_ONLY`) or the key is missing
   * (`PROVIDER_AUTH` with no HTTP status — an answered 401 carries one). Anything else is counted as sent.
   */
  private failureOf(
    err: unknown,
    signal: AbortSignal,
  ): { code: string; sent: boolean; exception: HttpException } {
    if (err instanceof AiStructuredOutputError) {
      return {
        code: 'EXTRACTION_UNREADABLE',
        sent: true,
        exception: refusal(
          HttpStatus.BAD_GATEWAY,
          'EXTRACTION_UNREADABLE',
          "Couldn't read this document. Nothing was filled; enter the purchase by hand.",
        ),
      };
    }
    if (signal.aborted) {
      return {
        code: 'EXTRACTION_TIMEOUT',
        sent: true,
        exception: refusal(
          HttpStatus.GATEWAY_TIMEOUT,
          'EXTRACTION_TIMEOUT',
          'Reading the document took too long. Nothing was filled.',
        ),
      };
    }
    if (err instanceof AiProviderError) {
      const beforeCall =
        err.code === 'AI_DISABLED' ||
        err.code === 'CONVERSATION_READ_ONLY' ||
        (err.code === 'PROVIDER_AUTH' && err.status === undefined);
      if (beforeCall) {
        // The configuration changed between the capability check and the call: nothing was sent.
        return {
          code: 'AI_DISABLED',
          sent: false,
          exception: refusal(
            HttpStatus.CONFLICT,
            'AI_DISABLED',
            UNAVAILABLE_MESSAGES.AI_DISABLED,
          ),
        };
      }
      return {
        code: err.code,
        sent: true,
        exception: refusal(
          HttpStatus.BAD_GATEWAY,
          err.code,
          PROVIDER_FAILURE_MESSAGES[err.code] ??
            `${err.message} Nothing was filled.`,
          err.retryAfterSec !== undefined
            ? { retryAfterSec: err.retryAfterSec }
            : {},
        ),
      };
    }
    // Not a classified model failure: log its class only (never its message, which may quote the request).
    this.logger.warn({
      event: 'ai.extraction.error',
      error: describeError(err),
    });
    return {
      code: 'INTERNAL',
      sent: true,
      exception:
        err instanceof HttpException
          ? err
          : new HttpException(
              { code: 'INTERNAL', message: 'The extraction failed' },
              HttpStatus.INTERNAL_SERVER_ERROR,
            ),
    };
  }
}
