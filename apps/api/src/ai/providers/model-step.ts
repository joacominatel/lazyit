import { Logger } from '@nestjs/common';
import {
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  type CallWarning,
  type JSONSchema7,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import {
  AI_WEB_SEARCH_QUERIES_MAX,
  AI_WEB_SEARCH_QUERY_MAX,
  AI_WEB_SOURCE_TITLE_MAX,
  AI_WEB_SOURCES_MAX,
  aiWebSearchSupported,
  isWebSourceUrl,
  type AiUsage,
} from '@lazyit/shared';

import type {
  ChatModelStepRequest,
  ChatModelStepResult,
  ChatModelToolDefinition,
  ChatModelWebSearch,
  ChatModelWebSource,
} from '../core/ports/chat-model.port';
import {
  AiProviderError,
  ProviderDownloadRefusedError,
} from './ai-provider.error';
import { classifyProviderError } from './provider-errors';
import {
  createProviderFetch,
  type ProviderFetchFactory,
} from './provider-fetch';
import { getProviderDefinition } from './provider.registry';
import type {
  LlmProviderDefinition,
  ProviderConfig,
  ToolChoiceMode,
} from './provider.types';

/**
 * One model step over AI SDK 7 (provider-and-runtime.md §6.1, §6.4): a single `streamText` call with
 * `stopWhen: isStepCount(1)` and the tools declared WITHOUT `execute`, so the SDK only reports the calls
 * the model proposed and lazyit's loop decides what runs. Shared by the `ChatModelPort` implementation and
 * the connection probe.
 */

/** DI token for {@link AiProviderLayerOptions} (test seams; production provides none). */
export const AI_PROVIDER_LAYER_OPTIONS = Symbol('AI_PROVIDER_LAYER_OPTIONS');

export interface AiProviderLayerOptions {
  /** Builds the egress-guarded fetch per call. Default: {@link createProviderFetch}. */
  fetchFactory?: ProviderFetchFactory;
  /** SDK retries of a transient failure (§6.4: 2). A write is never retried: tools never run here. */
  maxRetries?: number;
  /** Deadline of a model listing (default `MODEL_LIST_TIMEOUT_MS`). */
  modelListTimeoutMs?: number;
}

export const DEFAULT_PROVIDER_MAX_RETRIES = 2;

const logger = new Logger('AiProvider');

// The SDK prints its call warnings through `process.emitWarning`, outside pino. They are logged below as
// metadata through the Nest logger instead, so the SDK's own printing is turned off.
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = false;

/** The provider-facing tool set: name, description and JSON Schema only — never an executor. */
export function buildToolSet(
  tools: readonly ChatModelToolDefinition[],
): ToolSet {
  const set: ToolSet = {};
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
    });
  }
  return set;
}

/**
 * The provider-native web search tool for this step (#1389), or null: only when the conversation carries
 * it, the definition has one, and the model supports it. Its key never collides with a lazyit tool: the
 * registry's names are checked against it, and a clash drops the search instead of a lazyit tool.
 */
export function webSearchToolFor(
  definition: LlmProviderDefinition,
  modelId: string,
  request: Pick<ChatModelStepRequest, 'webSearch' | 'tools'>,
): { name: string; tool: ToolSet[string] } | null {
  if (!request.webSearch || !definition.webSearchTool) return null;
  if (!aiWebSearchSupported(definition.kind, modelId)) return null;
  const search = definition.webSearchTool(request.webSearch.maxUses);
  if (request.tools.some((tool) => tool.name === search.name)) return null;
  return search;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const query = value.replace(/\s+/g, ' ').trim();
  return query.length === 0 ? null : query.slice(0, AI_WEB_SEARCH_QUERY_MAX);
}

/**
 * What the provider's web search did in one step (#1389), read defensively from the SDK's step content:
 *   - searches — the provider-executed calls of the search tool (Anthropic `server_tool_use`, OpenAI
 *     `web_search_call`), or for Gemini the grounding queries it reports;
 *   - queries — `input.query` (Anthropic), `output.action.query` (OpenAI), `webSearchQueries` (Gemini);
 *   - sources — the step's URL sources (the citations / grounding chunks), `http(s)` only, deduplicated,
 *     capped; titles are other-authored text and are only trimmed here.
 * Null when nothing was searched and nothing was cited.
 */
export function webSearchOf(
  content: readonly unknown[],
  sources: readonly unknown[],
  providerMetadata: unknown,
  searchToolName: string,
): ChatModelWebSearch | null {
  let searches = 0;
  const queries: string[] = [];
  const addQuery = (value: unknown) => {
    const query = cleanQuery(value);
    if (
      query &&
      !queries.includes(query) &&
      queries.length < AI_WEB_SEARCH_QUERIES_MAX
    ) {
      queries.push(query);
    }
  };
  for (const item of content) {
    const part = asRecord(item);
    if (!part || part.providerExecuted !== true) continue;
    if (part.toolName !== searchToolName) continue;
    if (part.type === 'tool-call') {
      searches += 1;
      addQuery(asRecord(part.input)?.query);
    } else if (part.type === 'tool-result') {
      addQuery(asRecord(asRecord(part.output)?.action)?.query);
    }
  }
  const grounding = asRecord(
    asRecord(asRecord(providerMetadata)?.google)?.groundingMetadata,
  );
  if (grounding && Array.isArray(grounding.webSearchQueries)) {
    const reported = grounding.webSearchQueries.filter(
      (q) => cleanQuery(q) !== null,
    );
    searches = Math.max(searches, reported.length);
    reported.forEach(addQuery);
  }

  const found: ChatModelWebSource[] = [];
  const seen = new Set<string>();
  for (const item of sources) {
    const source = asRecord(item);
    if (
      !source ||
      source.sourceType !== 'url' ||
      typeof source.url !== 'string'
    )
      continue;
    const url = source.url.trim();
    if (!isWebSourceUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const title =
      typeof source.title === 'string'
        ? source.title
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, AI_WEB_SOURCE_TITLE_MAX)
        : '';
    found.push({ url, title: title.length > 0 ? title : null });
    if (found.length >= AI_WEB_SOURCES_MAX) break;
  }

  if (searches === 0 && found.length === 0) return null;
  return { searches, queries, sources: found };
}

/** The SDK's download hook: refuses any request (an empty batch needs nothing). */
function refuseDownload(
  requested: ReadonlyArray<{ url: URL }>,
): PromiseLike<never[]> {
  if (requested.length > 0) {
    return Promise.reject(new ProviderDownloadRefusedError());
  }
  return Promise.resolve([]);
}

/** SDK usage → the lazyit `AiUsage` wire shape (absent counters are 0 / omitted). */
export function toAiUsage(usage: LanguageModelUsage | undefined): AiUsage {
  const result: AiUsage = {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
  const cached = usage?.inputTokenDetails?.cacheReadTokens;
  if (cached !== undefined) {
    result.cachedInputTokens = cached;
  }
  const reasoning = usage?.outputTokenDetails?.reasoningTokens;
  if (reasoning !== undefined) {
    result.reasoningTokens = reasoning;
  }
  return result;
}

/**
 * Log SDK warnings as metadata. A Gemini replay that lost its thought signature only shows up here
 * (W1-B finding 5), so it is a warning worth seeing — but never with prompt content.
 */
function logWarnings(
  warnings: readonly CallWarning[] | undefined,
  provider: string,
  model: string,
): void {
  for (const warning of warnings ?? []) {
    const detail =
      warning.type === 'other'
        ? warning.message
        : 'feature' in warning
          ? String(warning.feature)
          : '';
    logger.warn({
      event: 'ai.provider.warning',
      provider,
      model,
      type: warning.type,
      detail: detail.slice(0, 200),
    });
  }
}

/**
 * The definition and SDK model for a configuration, with the key checked before any I/O. `toolChoice` is
 * what the SDK must be given after the definition's {@link LlmProviderDefinition.adaptCall}.
 */
export function resolveModel(
  config: ProviderConfig,
  modelId: string,
  toolChoice: ToolChoiceMode,
  options: AiProviderLayerOptions,
): {
  definition: LlmProviderDefinition;
  model: LanguageModel;
  toolChoice: ToolChoiceMode;
} {
  const definition = getProviderDefinition(config.provider);
  if (definition.requiresApiKey && !config.apiKey) {
    // Fail before the SDK could fall back to an environment variable key.
    throw new AiProviderError('PROVIDER_AUTH');
  }
  const fetchFactory = options.fetchFactory ?? createProviderFetch;
  const guarded = fetchFactory({
    kind: definition.kind,
    baseUrl: config.baseUrl,
    allowPrivateNetwork: config.allowPrivateNetwork,
  });
  const call = definition.adaptCall?.(guarded, toolChoice) ?? {
    fetch: guarded,
    toolChoice,
  };
  try {
    return {
      definition,
      model: definition.createModel(config, modelId, call.fetch),
      toolChoice: call.toolChoice,
    };
  } catch (err) {
    throw classifyProviderError(err, definition.errorPatterns);
  }
}

/** Run one model step against `config`. Throws {@link AiProviderError}, classified. */
export async function runModelStep(
  config: ProviderConfig,
  request: ChatModelStepRequest,
  options: AiProviderLayerOptions = {},
): Promise<ChatModelStepResult> {
  const modelId = request.model.modelId;
  const { definition, model, toolChoice } = resolveModel(
    config,
    modelId,
    request.toolChoice,
    options,
  );
  const settings = definition.callSettings(config, modelId);
  const signal = request.abortSignal;
  const tools = buildToolSet(request.tools);
  const search = webSearchToolFor(definition, modelId, request);
  if (search) {
    tools[search.name] = search.tool;
  }

  const result = streamText({
    model,
    instructions: settings.systemProviderOptions
      ? {
          role: 'system',
          content: request.instructions,
          providerOptions: settings.systemProviderOptions as never,
        }
      : request.instructions,
    messages: [...(request.messages as ModelMessage[])],
    tools,
    toolChoice,
    maxOutputTokens: request.maxOutputTokens,
    ...(settings.temperature !== undefined
      ? { temperature: settings.temperature }
      : {}),
    providerOptions: settings.providerOptions as never,
    abortSignal: signal,
    maxRetries: options.maxRetries ?? DEFAULT_PROVIDER_MAX_RETRIES,
    stopWhen: isStepCount(1),
    // Errors are read from the stream below and re-thrown classified. The SDK's default handler would
    // console.error the raw error, whose request body is the whole prompt (ADR-0031: no bodies in logs).
    onError: () => undefined,
    // INV-AI-7: the SDK would fetch a URL file part itself (global fetch, outside the egress guard) when
    // the model cannot take the URL directly. Refuse every such download instead.
    experimental_download: refuseDownload,
    // ADR-0031: prompts and completions never go to a telemetry integration, even if one is registered.
    telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
  });

  let failure: unknown;
  let aborted = false;
  try {
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        try {
          request.onTextDelta?.(part.text);
        } catch {
          // A failing listener (the event bus) must not fail the model step.
        }
      } else if (part.type === 'error') {
        failure ??= part.error;
      } else if (part.type === 'abort') {
        aborted = true;
      }
    }
  } catch (err) {
    failure ??= err;
  }

  if (aborted || signal?.aborted) {
    throw new AiProviderError('CANCELLED');
  }
  if (failure !== undefined) {
    throw classifyProviderError(failure, definition.errorPatterns, signal);
  }

  try {
    const [
      responseMessages,
      toolCalls,
      finishReason,
      usage,
      warnings,
      rawFinishReason,
    ] = await Promise.all([
      result.responseMessages,
      result.toolCalls,
      result.finishReason,
      result.usage,
      result.warnings,
      result.rawFinishReason,
    ]);
    logWarnings(warnings, definition.kind, modelId);
    const webSearch = search
      ? webSearchOf(
          await result.content,
          await result.sources,
          await result.providerMetadata,
          search.name,
        )
      : null;
    return {
      // Only the model's own message. For a call to an unknown tool the SDK synthesizes a `tool` message
      // with its own error text; the loop answers EVERY call itself in the one tool message it builds
      // (`toolResultsMessage`), so the SDK's would be a duplicate result.
      responseMessages: responseMessages.filter(
        (message) => message.role === 'assistant',
      ),
      // A provider-executed call (the web search) already ran on the provider's side; lazyit never answers
      // it — its result is part of the model's own message.
      toolCalls: toolCalls
        .filter(
          (call) =>
            (call as { providerExecuted?: boolean }).providerExecuted !== true,
        )
        .map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          // Unvalidated by design (the executor validates it with the tool's schema). The call may be
          // invalid: an unknown name (look it up with an own-property check — `constructor` is a name the
          // model can send) or an input whose JSON did not parse, which arrives as the RAW STRING. Every
          // call, invalid ones included, must be answered in the step's single tool message.
          input: call.input as unknown,
        })),
      finishReason,
      usage: toAiUsage(usage),
      ...(webSearch ? { webSearch } : {}),
      // Anthropic paused a long server-side turn (a search still going): continue it with another step.
      ...(rawFinishReason === 'pause_turn' ? { paused: true } : {}),
    };
  } catch (err) {
    throw classifyProviderError(err, definition.errorPatterns, signal);
  }
}
