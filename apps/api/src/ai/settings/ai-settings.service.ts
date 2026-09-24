import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AI_PROVIDER_DESCRIPTORS,
  AI_PROVIDER_OPTIONS_SCHEMAS,
  AI_SETTINGS_DEFAULTS,
  AiEffortSchema,
  AiProviderKindSchema,
  AiProviderOptionsSchema,
  McpClientAllowlistAddedReadSchema,
  type AiConnectionDraft,
  type AiConnectionTestResult,
  type AiEffort,
  type AiModelList,
  type AiProviderKind,
  type AiProviderOptions,
  type AiSettings,
  type McpClientAllowlistEntry,
  type UpdateAiSettings,
} from '@lazyit/shared';
import {
  Prisma,
  type AiSettings as AiSettingsRow,
} from '../../../generated/prisma/client';
import {
  EnvelopeCipher,
  type SecretEnvelope,
} from '../../common/crypto/envelope-cipher';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AiSettingsReader,
  ResolvedAiProviderConfig,
} from '../core/ports/ai-settings.port';
import { AiConnectionTester } from './ai-connection-tester';
import { currentProviderOverride } from './ai-provider-override';
import {
  AI_CONFIG_AUDIT_ACTIONS,
  AI_SETTINGS_SINGLETON_ID,
} from './ai-settings.constants';

/** DI token for the provider-key {@link EnvelopeCipher} (the `AI_SECRET_KEY` axis). */
export const AI_SECRET_CIPHER = Symbol('AI_SECRET_CIPHER');

/** What happened to the stored provider key on a write — the only key fact the audit ever records. */
export type AiKeyAction =
  | 'kept'
  | 'set'
  | 'cleared'
  | 'cleared-destination-changed'
  | 'none';

/** The fields a model call depends on. Any change to them invalidates `verifiedAt`. */
interface ConnectionFields {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  allowPrivateNetwork: boolean;
  effort: string | null;
  providerOptions: unknown;
}

/** The body of a 422 from the enable gate: the reason, and the test result when a test ran. */
export interface AiEnableRefusal {
  message: string;
  code:
    | 'DISCLOSURE_REQUIRED'
    | 'PROVIDER_NOT_CONFIGURED'
    | 'API_KEY_REQUIRED'
    | 'CONNECTION_TEST_FAILED';
  test?: AiConnectionTestResult;
}

/** True when auth is disabled (`AUTH_MODE=shim`): the assistant is never available there (security §12 G1). */
export function isShimMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_MODE === 'shim';
}

/**
 * AiSettingsService — the `ai_settings` singleton (ADR-0097 decision 7; provider-and-runtime.md §9.1, §10;
 * security.md §6.4–6.5). It mirrors `SmtpService` (ADR-0079): an absent row reads as the DISABLED default
 * and nothing is created until an admin saves. It is also the {@link AiSettingsReader} the runtime, the
 * provider layer, the status endpoint and `/mcp` read through (bound as `AI_SETTINGS_READER`).
 *
 * Key custody (INV-AI-6): the provider key is WRITE-ONLY — encrypted under `AI_SECRET_KEY` on write,
 * never returned, never audited, decrypted only in {@link resolveProviderConfig} and the connection test,
 * and cleared whenever the provider or the base URL changes (destination binding).
 */
@Injectable()
export class AiSettingsService implements AiSettingsReader {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_SECRET_CIPHER) private readonly cipher: EnvelopeCipher,
    private readonly tester: AiConnectionTester,
  ) {}

  /* ─────────────────────────────── reader port ─────────────────────────────── */

  async getSettings(): Promise<AiSettings> {
    const row = await this.findRow();
    return row ? this.toWire(row) : this.defaultWire();
  }

  async resolveProviderConfig(): Promise<ResolvedAiProviderConfig | null> {
    // A connection test in progress answers its draft, in its own async context only.
    const override = currentProviderOverride();
    if (override) return override;

    if (isShimMode()) return null;
    const row = await this.findRow();
    if (!row || !row.enabled) return null;
    const provider = parseProvider(row.provider);
    if (!provider || !row.model) return null;

    let apiKey: string | null = null;
    const envelope = envelopeOf(row);
    if (envelope) {
      try {
        apiKey = this.cipher.decrypt(envelope);
      } catch {
        // Wrong or missing AI_SECRET_KEY: the assistant is unavailable, not crashed. No detail logged.
        this.logger.warn(
          'AI provider key could not be decrypted; the assistant is unavailable until the key is re-entered.',
        );
        return null;
      }
    }
    return {
      provider,
      model: row.model,
      baseUrl: row.baseUrl,
      apiKey,
      allowPrivateNetwork: row.allowPrivateNetwork,
      effort: parseEffort(row.effort),
      providerOptions: parseProviderOptions(row.providerOptions),
    };
  }

  /** Whether a usable `AI_SECRET_KEY` is configured. */
  isKeyConfigured(): boolean {
    return this.cipher.isConfigured();
  }

  /** The `updatedAt` of the row, or null while none exists — the status `configRevision` source. */
  async getRevision(): Promise<Date | null> {
    const row = await this.prisma.aiSettings.findUnique({
      where: { id: AI_SETTINGS_SINGLETON_ID },
      select: { updatedAt: true },
    });
    return row?.updatedAt ?? null;
  }

  /* ─────────────────────────────── admin surface ────────────────────────────── */

  /**
   * `POST /config/ai/test` — test a DRAFT: each given field overrides the saved one and the key may be
   * typed inline. The saved key is used only when the draft keeps the saved provider AND base URL, so a
   * test can never send the stored key to a new destination (INV-AI-6). Persists nothing.
   */
  async testConnection(
    draft: AiConnectionDraft,
  ): Promise<AiConnectionTestResult> {
    const row = await this.findRow();
    const provider = draft.provider ?? parseProvider(row?.provider ?? null);
    const model = draft.model ?? row?.model ?? null;
    if (!provider || !model) {
      throw new BadRequestException(
        'Choose a provider and a model before testing the connection.',
      );
    }
    const baseUrl =
      draft.baseUrl !== undefined ? draft.baseUrl : (row?.baseUrl ?? null);
    const allowPrivateNetwork =
      draft.allowPrivateNetwork ?? row?.allowPrivateNetwork ?? false;
    const providerOptions =
      draft.providerOptions !== undefined
        ? draft.providerOptions
        : parseProviderOptions(row?.providerOptions ?? null);
    assertConnectionShape({
      provider,
      baseUrl,
      allowPrivateNetwork,
      providerOptions,
    });

    const sameDestination =
      row !== null && row.provider === provider && row.baseUrl === baseUrl;
    const apiKey =
      draft.apiKey ?? (sameDestination ? this.tryDecrypt(row) : null);

    return this.tester.test({
      provider,
      model,
      baseUrl,
      apiKey,
      allowPrivateNetwork,
      effort: parseEffort(row?.effort ?? null),
      providerOptions,
    });
  }

  /**
   * `POST /config/ai/models` — model suggestions for the wizard's combobox. `ChatModelPort` has no
   * listing call yet, so this answers the provider descriptor's suggested model; free text stays allowed
   * (the contract's "suggestions"). Live listing arrives with the provider layer.
   */
  async listModels(draft: AiConnectionDraft): Promise<AiModelList> {
    const row = draft.provider ? null : await this.findRow();
    const provider = draft.provider ?? parseProvider(row?.provider ?? null);
    if (!provider) return { models: [] };
    const suggested = AI_PROVIDER_DESCRIPTORS[provider].suggestedModel;
    return { models: suggested ? [{ id: suggested, label: null }] : [] };
  }

  /**
   * `PUT /config/ai` — a wholesale write (the SMTP pattern). In order:
   *   1. shape checks the zod schema cannot express (the http base-URL rule);
   *   2. the KEY: a value is encrypted (no `AI_SECRET_KEY` → {@link EnvelopeKeyMissingError}, 409 at the
   *      edge); `null` clears it; omitted keeps it — unless the provider or base URL changed, which
   *      clears it (destination binding);
   *   3. any change to the connection fields clears `verifiedAt`;
   *   4. `acknowledgeDisclosure: true` records the disclosure with its author, once;
   *   5. the ENABLE GATE, only when `enabled: true`: not shim (409), the disclosure acknowledged, a
   *      provider + model (+ base URL where required) (422), `AI_SECRET_KEY` usable whenever the provider
   *      takes a key or one is stored (409), the key itself when the provider needs one (422), and —
   *      when never verified or the connection changed — a passing inline connection test (422);
   *   6. one transaction: a CONDITIONAL write of the row as it was read (a concurrent save → 409) plus
   *      the redacted audit rows.
   * A refused write persists NOTHING. The MCP switch and the allowlist overlay pass no gate.
   */
  async updateSettings(
    input: UpdateAiSettings,
    actorId: string | null,
  ): Promise<AiSettings> {
    const row = await this.findRow();
    assertConnectionShape(input);

    // (2) The key.
    const destinationChanged =
      row !== null &&
      (row.provider !== input.provider || row.baseUrl !== input.baseUrl);
    const stored = row ? envelopeOf(row) : null;
    let keyAction: AiKeyAction;
    let envelope: SecretEnvelope | null | undefined; // undefined = leave the columns as they are
    let plaintextKey: string | null;
    if (typeof input.apiKey === 'string') {
      envelope = this.cipher.encrypt(input.apiKey); // throws EnvelopeKeyMissingError → 409
      keyAction = 'set';
      plaintextKey = input.apiKey;
    } else if (input.apiKey === null) {
      envelope = null;
      keyAction = stored ? 'cleared' : 'none';
      plaintextKey = null;
    } else if (destinationChanged && stored) {
      envelope = null;
      keyAction = 'cleared-destination-changed';
      plaintextKey = null;
    } else {
      envelope = undefined;
      keyAction = stored ? 'kept' : 'none';
      plaintextKey = null; // decrypted lazily, only if the gate needs a test
    }
    const keyStoredAfter =
      envelope === undefined ? stored !== null : envelope !== null;

    // (3) Verification.
    const connectionChanged =
      !row ||
      keyAction === 'set' ||
      keyAction === 'cleared' ||
      keyAction === 'cleared-destination-changed' ||
      !sameConnection(connectionOf(row), connectionOf(input));
    let verifiedAt: Date | null = connectionChanged
      ? null
      : (row?.verifiedAt ?? null);

    // (4) Disclosure.
    const now = new Date();
    const acknowledgingNow =
      input.acknowledgeDisclosure === true && !row?.disclosureAcknowledgedAt;
    const disclosureAcknowledgedAt = acknowledgingNow
      ? now
      : (row?.disclosureAcknowledgedAt ?? null);

    // (5) The enable gate.
    if (input.enabled) {
      if (isShimMode()) {
        throw new ConflictException(
          'The AI assistant cannot be enabled while authentication is disabled (AUTH_MODE=shim).',
        );
      }
      if (!disclosureAcknowledgedAt) {
        throw refuse({
          code: 'DISCLOSURE_REQUIRED',
          message:
            'Acknowledge the data-egress disclosure before enabling the AI assistant.',
        });
      }
      const provider = input.provider;
      if (
        !provider ||
        !input.model ||
        (AI_PROVIDER_DESCRIPTORS[provider].requiresBaseUrl && !input.baseUrl)
      ) {
        throw refuse({
          code: 'PROVIDER_NOT_CONFIGURED',
          message:
            'Choose a provider and a model (and a base URL where required) before enabling.',
        });
      }
      // A provider that takes a key — or any stored key — needs AI_SECRET_KEY to be usable. Only a keyless
      // OpenAI-compatible server runs without it (provider-and-runtime.md §12).
      if (
        (AI_PROVIDER_DESCRIPTORS[provider].requiresApiKey || keyStoredAfter) &&
        !this.cipher.isConfigured()
      ) {
        throw new ConflictException(
          'AI_SECRET_KEY is not set — set a 32-byte key (openssl rand -hex 32) before enabling this provider.',
        );
      }
      if (verifiedAt === null) {
        const apiKey =
          plaintextKey ?? (keyStoredAfter && row ? this.tryDecrypt(row) : null);
        if (AI_PROVIDER_DESCRIPTORS[provider].requiresApiKey && !apiKey) {
          throw refuse({
            code: 'API_KEY_REQUIRED',
            message: 'This provider needs an API key before it can be enabled.',
          });
        }
        const test = await this.tester.test({
          provider,
          model: input.model,
          baseUrl: input.baseUrl,
          apiKey,
          allowPrivateNetwork: input.allowPrivateNetwork,
          effort: input.effort,
          providerOptions: input.providerOptions,
        });
        if (!test.ok) {
          throw refuse({
            code: 'CONNECTION_TEST_FAILED',
            message:
              'The connection test failed; the assistant was not enabled.',
            test,
          });
        }
        verifiedAt = new Date();
      }
    }

    // (6) Persist + audit.
    const data = {
      enabled: input.enabled,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      allowPrivateNetwork: input.allowPrivateNetwork,
      effort: input.effort,
      providerOptions:
        input.providerOptions === null
          ? Prisma.DbNull
          : (input.providerOptions as Prisma.InputJsonValue),
      instructions: input.instructions,
      maxStepsPerRun: input.maxStepsPerRun,
      maxOutputTokens: input.maxOutputTokens,
      contextTokenLimit: input.contextTokenLimit,
      dailyTokenLimitPerPrincipal: input.dailyTokenLimitPerPrincipal,
      retentionDays: input.retentionDays,
      approvalTtlMinutes: input.approvalTtlMinutes,
      mcpEnabled: input.mcpEnabled,
      mcpClientAllowlistAdded:
        input.mcpClientAllowlistAdded as unknown as Prisma.InputJsonValue,
      mcpClientAllowlistRemovedDefaults:
        input.mcpClientAllowlistRemovedDefaults,
      mcpAllowAnyHttpsClient: input.mcpAllowAnyHttpsClient,
      verifiedAt,
      disclosureAcknowledgedAt,
      ...(acknowledgingNow ? { disclosureAcknowledgedById: actorId } : {}),
      ...(envelope === undefined ? {} : envelopeColumns(envelope)),
      updatedById: actorId,
    };

    const before = row ? this.toWire(row) : this.defaultWire();
    const changes = diffSettings(before, input, keyAction);
    const audits: Prisma.AiConfigAuditLogCreateManyInput[] = [];
    if (Object.keys(changes).length > 0) {
      audits.push({
        action: AI_CONFIG_AUDIT_ACTIONS.settingsUpdated,
        actorId,
        detail: { changes } as Prisma.InputJsonValue,
      });
    }
    if (acknowledgingNow) {
      audits.push({
        action: AI_CONFIG_AUDIT_ACTIONS.disclosureAcknowledged,
        actorId,
        detail: {
          provider: input.provider,
          baseUrl: redactUrl(input.baseUrl),
        },
      });
    }

    // A CONDITIONAL write (review F1): the row is written only if it is still the one read above, so the
    // destination check (which decides whether the stored key survives) and the write see the same row.
    // A concurrent save in between → 409 and nothing persisted; the admin reloads and saves again. No row
    // lock is held across the inline connection test, which can take up to a minute.
    const saved = await this.prisma.$transaction(async (tx) => {
      if (row) {
        const { count } = await tx.aiSettings.updateMany({
          where: { id: AI_SETTINGS_SINGLETON_ID, updatedAt: row.updatedAt },
          data,
        });
        if (count !== 1) throw concurrentSave();
      } else {
        try {
          await tx.aiSettings.create({
            data: { id: AI_SETTINGS_SINGLETON_ID, ...data },
          });
        } catch (err) {
          // Another first save created the singleton meanwhile (unique violation on the id).
          if ((err as { code?: unknown }).code === 'P2002') {
            throw concurrentSave();
          }
          throw err;
        }
      }
      for (const audit of audits) {
        await tx.aiConfigAuditLog.create({ data: audit });
      }
      return tx.aiSettings.findUniqueOrThrow({
        where: { id: AI_SETTINGS_SINGLETON_ID },
      });
    });
    return this.toWire(saved);
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  private findRow(): Promise<AiSettingsRow | null> {
    return this.prisma.aiSettings.findUnique({
      where: { id: AI_SETTINGS_SINGLETON_ID },
    });
  }

  /** Decrypt the stored key for an in-memory test; a wrong or missing key reads as "no key". */
  private tryDecrypt(row: AiSettingsRow | null): string | null {
    const envelope = row ? envelopeOf(row) : null;
    if (!envelope) return null;
    try {
      return this.cipher.decrypt(envelope);
    } catch {
      return null;
    }
  }

  private defaultWire(): AiSettings {
    return {
      ...AI_SETTINGS_DEFAULTS,
      mcpClientAllowlistAdded: [],
      mcpClientAllowlistRemovedDefaults: [],
      provider: null,
      model: null,
      baseUrl: null,
      apiKeySet: false,
      keyConfigured: this.cipher.isConfigured(),
      effort: null,
      providerOptions: null,
      instructions: null,
      disclosureAcknowledgedAt: null,
      verifiedAt: null,
      updatedAt: null,
    };
  }

  /**
   * The redacted wire shape. Drops the key envelope entirely (only `apiKeySet`). Read-tolerant: a
   * provider, effort, option set or allowlist entry this build does not know reads as null / is dropped,
   * never a 500 (upgrade-safety).
   */
  private toWire(row: AiSettingsRow): AiSettings {
    const added = McpClientAllowlistAddedReadSchema.safeParse(
      row.mcpClientAllowlistAdded,
    );
    return {
      enabled: row.enabled,
      provider: parseProvider(row.provider),
      model: row.model,
      baseUrl: row.baseUrl,
      apiKeySet: row.apiKeyCiphertext !== null,
      keyConfigured: this.cipher.isConfigured(),
      allowPrivateNetwork: row.allowPrivateNetwork,
      effort: parseEffort(row.effort),
      providerOptions: parseProviderOptions(row.providerOptions),
      instructions: row.instructions,
      maxStepsPerRun: row.maxStepsPerRun,
      maxOutputTokens: row.maxOutputTokens,
      contextTokenLimit: row.contextTokenLimit,
      dailyTokenLimitPerPrincipal: row.dailyTokenLimitPerPrincipal,
      retentionDays: row.retentionDays,
      approvalTtlMinutes: row.approvalTtlMinutes,
      mcpEnabled: row.mcpEnabled,
      mcpClientAllowlistAdded: added.success ? added.data : [],
      mcpClientAllowlistRemovedDefaults: row.mcpClientAllowlistRemovedDefaults,
      mcpAllowAnyHttpsClient: row.mcpAllowAnyHttpsClient,
      disclosureAcknowledgedAt:
        row.disclosureAcknowledgedAt?.toISOString() ?? null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/* ─────────────────────────────── pure helpers ─────────────────────────────── */

function concurrentSave(): ConflictException {
  return new ConflictException(
    'The AI settings were changed by someone else meanwhile — reload them and save again.',
  );
}

function refuse(body: AiEnableRefusal): UnprocessableEntityException {
  return new UnprocessableEntityException(body);
}

export function parseProvider(value: string | null): AiProviderKind | null {
  const parsed = AiProviderKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseEffort(value: string | null): AiEffort | null {
  const parsed = AiEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseProviderOptions(value: unknown): AiProviderOptions | null {
  if (value === null || value === undefined) return null;
  const parsed = AiProviderOptionsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function envelopeOf(row: AiSettingsRow): SecretEnvelope | null {
  if (
    row.apiKeyCiphertext === null ||
    row.apiKeyIv === null ||
    row.apiKeyAuthTag === null ||
    row.apiKeyKeyVersion === null
  ) {
    return null;
  }
  return {
    ciphertext: row.apiKeyCiphertext,
    iv: row.apiKeyIv,
    authTag: row.apiKeyAuthTag,
    keyVersion: row.apiKeyKeyVersion,
  };
}

function envelopeColumns(envelope: SecretEnvelope | null) {
  return {
    apiKeyCiphertext: envelope?.ciphertext ?? null,
    apiKeyIv: envelope?.iv ?? null,
    apiKeyAuthTag: envelope?.authTag ?? null,
    apiKeyKeyVersion: envelope?.keyVersion ?? null,
  };
}

function connectionOf(value: {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  allowPrivateNetwork: boolean;
  effort: string | null;
  providerOptions: unknown;
}): ConnectionFields {
  return {
    provider: value.provider,
    model: value.model,
    baseUrl: value.baseUrl,
    allowPrivateNetwork: value.allowPrivateNetwork,
    effort: value.effort,
    providerOptions: value.providerOptions ?? null,
  };
}

function sameConnection(a: ConnectionFields, b: ConnectionFields): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.baseUrl === b.baseUrl &&
    a.allowPrivateNetwork === b.allowPrivateNetwork &&
    a.effort === b.effort &&
    stableJson(a.providerOptions) === stableJson(b.providerOptions)
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Checks the zod schema leaves to the API:
 *   - `http:` base URLs only for the OpenAI-compatible provider with the private-network option on
 *     (INV-AI-7; the egress guard still decides at call time whether the host really is private);
 *   - the private-network option and the provider options belong to the selected provider.
 */
function assertConnectionShape(value: {
  provider: AiProviderKind | null;
  baseUrl: string | null;
  allowPrivateNetwork: boolean;
  providerOptions: AiProviderOptions | null;
}): void {
  if (value.baseUrl && /^http:\/\//i.test(value.baseUrl.trim())) {
    if (value.provider !== 'openai-compatible' || !value.allowPrivateNetwork) {
      throw new BadRequestException(
        'A plain http:// base URL is allowed only for the OpenAI-compatible provider on a private network (enable the private-network option).',
      );
    }
  }
  if (value.allowPrivateNetwork && value.provider !== 'openai-compatible') {
    throw new BadRequestException(
      'A private-network host is allowed only for the OpenAI-compatible provider.',
    );
  }
  if (
    value.providerOptions !== null &&
    (value.provider === null ||
      !AI_PROVIDER_OPTIONS_SCHEMAS[value.provider].safeParse(
        value.providerOptions,
      ).success)
  ) {
    throw new BadRequestException(
      'These options are not supported by the selected provider.',
    );
  }
}

/** A URL with its credentials, query and fragment removed — for the audit, which never holds a secret. */
export function redactUrl(value: string | null): string | null {
  if (!value) return value;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[unparseable]';
  }
}

/** The plain fields the audit diff records as before/after. */
const PLAIN_AUDIT_FIELDS = [
  'enabled',
  'provider',
  'model',
  'allowPrivateNetwork',
  'effort',
  'providerOptions',
  'maxStepsPerRun',
  'maxOutputTokens',
  'contextTokenLimit',
  'dailyTokenLimitPerPrincipal',
  'retentionDays',
  'approvalTtlMinutes',
  'mcpEnabled',
  'mcpAllowAnyHttpsClient',
  'mcpClientAllowlistRemovedDefaults',
] as const;

/**
 * The REDACTED diff of a write, for `ai_config_audit_log.detail.changes`:
 *   - plain fields → `{ before, after }`;
 *   - `baseUrl` → before/after without credentials, query or fragment;
 *   - `instructions` → lengths only (free text stays out of the audit);
 *   - the allowlist overlay → the entries added and the ids removed;
 *   - the key → only what happened to it (`set` / `cleared` / `cleared-destination-changed`), never a
 *     value, a hint or a ciphertext.
 */
export function diffSettings(
  before: AiSettings,
  input: UpdateAiSettings,
  keyAction: AiKeyAction,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of PLAIN_AUDIT_FIELDS) {
    const a: unknown = before[field];
    const b: unknown = input[field];
    if (stableJson(a ?? null) !== stableJson(b ?? null)) {
      changes[field] = { before: a ?? null, after: b ?? null };
    }
  }
  if (before.baseUrl !== input.baseUrl) {
    changes.baseUrl = {
      before: redactUrl(before.baseUrl),
      after: redactUrl(input.baseUrl),
    };
  }
  if ((before.instructions ?? null) !== (input.instructions ?? null)) {
    changes.instructions = {
      beforeLength: before.instructions?.length ?? 0,
      afterLength: input.instructions?.length ?? 0,
    };
  }
  const allowlist = diffAllowlist(
    before.mcpClientAllowlistAdded,
    input.mcpClientAllowlistAdded,
  );
  if (allowlist) changes.mcpClientAllowlistAdded = allowlist;
  if (keyAction !== 'kept' && keyAction !== 'none') {
    changes.apiKey = keyAction;
  }
  return changes;
}

function diffAllowlist(
  before: readonly McpClientAllowlistEntry[],
  after: readonly McpClientAllowlistEntry[],
): { added: McpClientAllowlistEntry[]; removed: string[] } | null {
  const beforeById = new Map(before.map((e) => [e.id, stableJson(e)]));
  const afterIds = new Set(after.map((e) => e.id));
  const added = after.filter((e) => beforeById.get(e.id) !== stableJson(e));
  const removed = before.filter((e) => !afterIds.has(e.id)).map((e) => e.id);
  return added.length || removed.length ? { added, removed } : null;
}
