import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { AiProviderError } from '../ai-provider.error';
import { fetchModelList, joinUrl, parseDataIdList } from '../model-listing';
import type {
  LlmProviderDefinition,
  ProviderConfig,
  ProviderErrorPatterns,
} from '../provider.types';

const CONTEXT_LIMIT =
  /maximum context length|context length|context window|too many tokens|exceeds? .*context/i;
const ERROR_PATTERNS: ProviderErrorPatterns = { contextLimit: CONTEXT_LIMIT };

function baseUrlOf(config: ProviderConfig): string {
  if (!config.baseUrl) {
    // The settings require a base URL for this provider; a row without one is not configured.
    throw new AiProviderError('AI_DISABLED');
  }
  return config.baseUrl;
}

/**
 * Any OpenAI-compatible Chat Completions server (Ollama, vLLM, LM Studio, a gateway…) —
 * provider-and-runtime.md §6.3.
 *
 * - The base URL is mandatory and the key optional (a local server may need none).
 * - The only provider that may reach a private-network host, when the admin turned `allowPrivateNetwork`
 *   on — enforced in `provider-fetch.ts`, scoped to this base URL's host.
 * - The only provider whose `temperature` extra is honoured. `effort` is not sent: servers differ in
 *   whether they accept `reasoning_effort`, and an unknown field can be a 400.
 * - `includeUsage: true`, so streamed responses report token usage.
 */
export const openaiCompatibleProvider: LlmProviderDefinition = {
  kind: 'openai-compatible',
  requiresApiKey: false,
  defaultBaseUrl: null,
  errorPatterns: ERROR_PATTERNS,

  createModel(config, modelId, fetch) {
    return createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: baseUrlOf(config),
      apiKey: config.apiKey ?? undefined,
      includeUsage: true,
      fetch,
    })(modelId);
  },

  callSettings(config) {
    const temperature = config.providerOptions?.temperature;
    return temperature === undefined ? {} : { temperature };
  },

  listModels(config, fetch) {
    return fetchModelList(
      fetch,
      joinUrl(baseUrlOf(config), 'models'),
      config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      (body) => parseDataIdList(body),
      ERROR_PATTERNS,
    );
  },
};
