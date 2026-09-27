import type { AiProviderKind } from '@lazyit/shared';

import { AiProviderError } from './ai-provider.error';
import { anthropicProvider } from './anthropic/anthropic.provider';
import { googleProvider } from './google/google.provider';
import { openaiCompatibleProvider } from './openai-compatible/openai-compatible.provider';
import { openaiProvider } from './openai/openai.provider';
import type { LlmProviderDefinition } from './provider.types';

/**
 * Every provider lazyit can call — one line per kind (provider-and-runtime.md §6.3). The `Record` over the
 * shared `AiProviderKind` makes a kind added to `@lazyit/shared` without a definition a compile error.
 */
export const PROVIDER_REGISTRY: Readonly<
  Record<AiProviderKind, LlmProviderDefinition>
> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  'openai-compatible': openaiCompatibleProvider,
};

/**
 * The definition for a stored provider kind. The kind is a text column tolerated on read, so a value
 * written by a newer build is "not configured" here rather than a crash.
 */
export function getProviderDefinition(kind: string): LlmProviderDefinition {
  const definition = Object.prototype.hasOwnProperty.call(
    PROVIDER_REGISTRY,
    kind,
  )
    ? PROVIDER_REGISTRY[kind as AiProviderKind]
    : undefined;
  if (!definition) {
    throw new AiProviderError('AI_DISABLED');
  }
  return definition;
}
