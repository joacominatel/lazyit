import { createGoogle } from '@ai-sdk/google';

import { fetchModelList, joinUrl } from '../model-listing';
import type {
  LlmProviderDefinition,
  ModelInfo,
  ProviderErrorPatterns,
} from '../provider.types';

const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const CONTEXT_LIMIT =
  /input token count.*exceeds|exceeds the maximum number of tokens|context (window|length)/i;
/** Gemini answers an invalid key with a 400 `API_KEY_INVALID`, not a 401. */
const ERROR_PATTERNS: ProviderErrorPatterns = {
  contextLimit: CONTEXT_LIMIT,
  auth: /API_KEY_INVALID|API key not valid|API key expired/i,
};

function parseGeminiModels(body: unknown): ModelInfo[] {
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new Error('not a model list');
  }
  return models.flatMap((entry: unknown) => {
    const record = entry as {
      name?: unknown;
      displayName?: unknown;
      supportedGenerationMethods?: unknown;
    };
    const methods = Array.isArray(record?.supportedGenerationMethods)
      ? (record.supportedGenerationMethods as unknown[])
      : [];
    if (
      typeof record?.name !== 'string' ||
      !methods.includes('generateContent')
    ) {
      return [];
    }
    return [
      {
        id: record.name.replace(/^models\//, ''),
        label:
          typeof record.displayName === 'string' ? record.displayName : null,
      },
    ];
  });
}

/**
 * Google Gemini (Gemini API key, not Vertex) — provider-and-runtime.md §6.3.
 *
 * - `effort` maps to `thinkingConfig.thinkingLevel`, the one reasoning mechanism for this provider
 *   (W1-B finding 6). Thought signatures ride the persisted messages' `providerOptions` untouched
 *   (finding 5); the SDK's "skip_thought_signature_validator" warning is logged by the chat model as a
 *   replay bug.
 * - The key and base URL are always explicit, so `GOOGLE_GENERATIVE_AI_API_KEY` never applies.
 * - The model list keeps only models that support `generateContent`.
 */
export const googleProvider: LlmProviderDefinition = {
  kind: 'google',
  requiresApiKey: true,
  defaultBaseUrl: GOOGLE_BASE_URL,
  errorPatterns: ERROR_PATTERNS,

  createModel(config, modelId, fetch) {
    return createGoogle({
      apiKey: config.apiKey ?? '',
      baseURL: config.baseUrl ?? GOOGLE_BASE_URL,
      fetch,
    })(modelId);
  },

  callSettings(config) {
    return config.effort
      ? {
          providerOptions: {
            google: { thinkingConfig: { thinkingLevel: config.effort } },
          },
        }
      : {};
  },

  listModels(config, fetch) {
    return fetchModelList(
      fetch,
      joinUrl(config.baseUrl ?? GOOGLE_BASE_URL, 'models?pageSize=1000'),
      { 'x-goog-api-key': config.apiKey ?? '' },
      parseGeminiModels,
      ERROR_PATTERNS,
    );
  },
};
