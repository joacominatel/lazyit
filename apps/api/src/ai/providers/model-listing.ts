import { AiProviderError } from './ai-provider.error';
import { classifyHttpStatus, classifyProviderError } from './provider-errors';
import type {
  FetchLike,
  ModelInfo,
  ProviderErrorPatterns,
} from './provider.types';

/**
 * Shared plumbing for `LlmProviderDefinition.listModels` (provider-and-runtime.md §6.3). A listing is a GET
 * through the guarded fetch; its body is parsed into ids and labels and never returned or echoed, so a
 * failure cannot become a reflected read of an arbitrary upstream (security.md §6.4).
 */

/** A model list is small; anything past this is not a model list. */
export const MODEL_LIST_MAX_BYTES = 2 * 1024 * 1024;
/** The combobox needs suggestions, not the whole catalogue of a busy gateway. */
export const MODEL_LIST_MAX_ENTRIES = 500;

async function readCapped(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MODEL_LIST_MAX_BYTES) {
      await reader.cancel();
      throw new AiProviderError('PROVIDER_UNAVAILABLE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * GET `url` and map the JSON body with `parse`. Throws {@link AiProviderError}: an HTTP error by its
 * status, an unparseable or oversized body as `PROVIDER_UNAVAILABLE`.
 */
export async function fetchModelList(
  fetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  parse: (body: unknown) => ModelInfo[],
  errorPatterns: ProviderErrorPatterns,
): Promise<ModelInfo[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
    });
  } catch (err) {
    throw classifyProviderError(err, errorPatterns);
  }

  if (!response.ok) {
    // Read (capped) only to classify — e.g. Gemini's 400 for a bad key; never returned.
    const text = await readCapped(response).catch(() => '');
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    throw classifyHttpStatus(
      response.status,
      text,
      errorPatterns,
      responseHeaders,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await readCapped(response));
  } catch (err) {
    if (err instanceof AiProviderError) {
      throw err;
    }
    throw new AiProviderError('PROVIDER_UNAVAILABLE');
  }

  let models: ModelInfo[];
  try {
    models = parse(body);
  } catch {
    throw new AiProviderError('PROVIDER_UNAVAILABLE');
  }
  const seen = new Set<string>();
  return models
    .filter((m) => {
      if (!m.id || seen.has(m.id)) {
        return false;
      }
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MODEL_LIST_MAX_ENTRIES);
}

/** The `{ data: [{ id }] }` shape the OpenAI and Anthropic model endpoints share. */
export function parseDataIdList(body: unknown, labelKey?: string): ModelInfo[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('not a model list');
  }
  return data.flatMap((entry: unknown) => {
    const record = entry as Record<string, unknown>;
    if (typeof record?.id !== 'string') {
      return [];
    }
    const label =
      labelKey && typeof record[labelKey] === 'string'
        ? record[labelKey]
        : null;
    return [{ id: record.id, label }];
  });
}
