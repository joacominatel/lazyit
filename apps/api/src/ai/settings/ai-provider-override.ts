import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';

/**
 * The CONNECTION-TEST SEAM. `ChatModelPort.step()` names only `{ provider, modelId }`; the provider layer
 * gets the endpoint and the key through `AiSettingsReader.resolveProviderConfig()`. To test a DRAFT
 * (fields not saved yet, the key typed inline, the assistant still disabled) without widening the port,
 * the connection tester runs the one test step inside {@link withProviderOverride}, and the reader answers
 * the draft for every call made in that async context — and only there. Outside it, nothing changes.
 *
 * The override lives in memory for the duration of one test call; it is never persisted or logged.
 */
const storage = new AsyncLocalStorage<ResolvedAiProviderConfig>();

/** Run `fn` with `config` as the provider configuration the settings reader resolves. */
export function withProviderOverride<T>(
  config: ResolvedAiProviderConfig,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(config, fn);
}

/** The override active in this async context, if any. */
export function currentProviderOverride():
  | ResolvedAiProviderConfig
  | undefined {
  return storage.getStore();
}
