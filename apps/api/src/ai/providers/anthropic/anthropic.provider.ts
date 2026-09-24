import { createAnthropic } from '@ai-sdk/anthropic';

import { fetchModelList, joinUrl, parseDataIdList } from '../model-listing';
import type {
  FetchLike,
  LlmProviderDefinition,
  ProviderErrorPatterns,
} from '../provider.types';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const CONTEXT_LIMIT =
  /prompt is too long|exceed.*context (window|limit)|input length and `?max_tokens`? exceed/i;
const ERROR_PATTERNS: ProviderErrorPatterns = { contextLimit: CONTEXT_LIMIT };

/**
 * On a `toolChoice: 'none'` step the Anthropic SDK drops the `tools` array entirely. That breaks the
 * forced final step twice: a history holding `tool_use` / `tool_result` blocks is rejected when no tools
 * are declared, and the frozen tools prefix (preserved thinking, prompt cache) changes. So the SDK is
 * given `auto` — tools stay declared exactly as on every other step — and the request body is rewritten
 * to Anthropic's native `tool_choice: { type: 'none' }`.
 */
function forceNoToolUse(fetch: FetchLike): FetchLike {
  return (input, init) => {
    if (typeof init?.body !== 'string') {
      return fetch(input, init);
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return fetch(input, init);
    }
    body.tool_choice = { type: 'none' };
    return fetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Anthropic (Messages API) — provider-and-runtime.md §6.3.
 *
 * - The key and base URL are always passed explicitly, so neither `ANTHROPIC_API_KEY` nor
 *   `ANTHROPIC_BASE_URL` from the environment can ever apply.
 * - Prompt caching: a breakpoint at the end of the frozen system prompt plus the request-level automatic
 *   breakpoint, which follows the last message of the append-only history.
 * - `effort` maps to `providerOptions.anthropic.effort` (the one reasoning mechanism for this provider —
 *   W1-B finding 6); thinking stays the model's default (adaptive on current models). No sampling
 *   parameters are ever sent: current models reject them with a 400.
 * - `toolChoice: 'none'` keeps the tools declared ({@link forceNoToolUse}).
 */
export const anthropicProvider: LlmProviderDefinition = {
  kind: 'anthropic',
  requiresApiKey: true,
  defaultBaseUrl: ANTHROPIC_BASE_URL,
  errorPatterns: ERROR_PATTERNS,

  createModel(config, modelId, fetch) {
    return createAnthropic({
      apiKey: config.apiKey ?? '',
      baseURL: config.baseUrl ?? ANTHROPIC_BASE_URL,
      fetch,
    })(modelId);
  },

  adaptCall(fetch, toolChoice) {
    return toolChoice === 'none'
      ? { fetch: forceNoToolUse(fetch), toolChoice: 'auto' }
      : { fetch, toolChoice };
  },

  callSettings(config) {
    const cacheControl = { type: 'ephemeral' };
    return {
      providerOptions: {
        anthropic: {
          cacheControl,
          ...(config.effort ? { effort: config.effort } : {}),
        },
      },
      systemProviderOptions: { anthropic: { cacheControl } },
    };
  },

  listModels(config, fetch) {
    return fetchModelList(
      fetch,
      joinUrl(config.baseUrl ?? ANTHROPIC_BASE_URL, 'models?limit=1000'),
      {
        'x-api-key': config.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      (body) => parseDataIdList(body, 'display_name'),
      ERROR_PATTERNS,
    );
  },
};
