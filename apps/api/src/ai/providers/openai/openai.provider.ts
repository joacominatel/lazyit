import { createOpenAI, openai } from '@ai-sdk/openai';

import { fetchModelList, joinUrl, parseDataIdList } from '../model-listing';
import type {
  LlmProviderDefinition,
  ProviderErrorPatterns,
} from '../provider.types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const CONTEXT_LIMIT =
  /context_length_exceeded|maximum context length|exceeds the context window/i;
const ERROR_PATTERNS: ProviderErrorPatterns = { contextLimit: CONTEXT_LIMIT };
/** Ids the OpenAI catalogue lists that are not chat models. */
const NON_CHAT_MODEL =
  /embedding|tts|whisper|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|sora/i;

/**
 * OpenAI (Responses API) — provider-and-runtime.md §6.3.
 *
 * - `store: false`, so OpenAI keeps no copy of the generation. For the reasoning models the SDK then asks
 *   for `reasoning.encrypted_content` and replays it statelessly from the persisted messages (W1-B
 *   findings 4–5). A custom or aliased id the SDK does not recognise as a reasoning model is sent as a
 *   plain model: forcing reasoning on would break the non-reasoning models (`gpt-4.1`, …).
 * - `effort` maps to `reasoningEffort`, the one reasoning mechanism for this provider (finding 6).
 * - The key and base URL are always explicit, so `OPENAI_API_KEY` / `OPENAI_BASE_URL` never apply.
 * - Web search (#1389) is the Responses API `web_search` tool: OpenAI runs it. It takes no per-call cap;
 *   with `store: false` the SDK does not replay the search item, only the answer that cites it.
 */
export const openaiProvider: LlmProviderDefinition = {
  kind: 'openai',
  requiresApiKey: true,
  defaultBaseUrl: OPENAI_BASE_URL,
  errorPatterns: ERROR_PATTERNS,

  createModel(config, modelId, fetch) {
    return createOpenAI({
      apiKey: config.apiKey ?? '',
      baseURL: config.baseUrl ?? OPENAI_BASE_URL,
      fetch,
    })(modelId);
  },

  webSearchTool() {
    return { name: 'web_search', tool: openai.tools.webSearch({}) };
  },

  callSettings(config) {
    return {
      providerOptions: {
        openai: {
          store: false,
          ...(config.effort ? { reasoningEffort: config.effort } : {}),
        },
      },
    };
  },

  listModels(config, fetch) {
    return fetchModelList(
      fetch,
      joinUrl(config.baseUrl ?? OPENAI_BASE_URL, 'models'),
      { authorization: `Bearer ${config.apiKey ?? ''}` },
      (body) => parseDataIdList(body).filter((m) => !NON_CHAT_MODEL.test(m.id)),
      ERROR_PATTERNS,
    );
  },
};
