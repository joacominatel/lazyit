import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ModelMessage, ToolModelMessage } from 'ai';

import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import type {
  ChatModelMessage,
  ChatModelPort,
  ChatModelStepRequest,
  ChatModelStepResult,
  ChatModelToolOutcome,
} from '../core/ports/chat-model.port';
import { AiProviderError } from './ai-provider.error';
import {
  AI_PROVIDER_LAYER_OPTIONS,
  runModelStep,
  type AiProviderLayerOptions,
} from './model-step';

type ToolResultOutput = Extract<
  ToolModelMessage['content'][number],
  { type: 'tool-result' }
>['output'];

function toToolOutput(outcome: ChatModelToolOutcome): ToolResultOutput {
  const value = outcome.output;
  if (typeof value === 'string') {
    return outcome.isError
      ? { type: 'error-text', value }
      : { type: 'text', value };
  }
  // Round-trip through JSON so the stored message is exactly what a reload will read back.
  const json = JSON.parse(JSON.stringify(value ?? null)) as never;
  return outcome.isError
    ? { type: 'error-json', value: json }
    : { type: 'json', value: json };
}

/**
 * THE `ChatModelPort` implementation over AI SDK 7 (provider-and-runtime.md §6.1–§6.4; ADR-0097 decision
 * 5). Each `step` reads the current provider connection from the settings reader, checks it still matches
 * the provider the conversation is pinned to, and runs one model step through the provider definition
 * and the egress-guarded fetch.
 *
 * The connection is read through `AI_SETTINGS_READER` (exported by `AiSettingsModule`, which this module
 * imports) on EVERY step and never cached: the settings unit's connection tester runs a step inside a
 * scoped override that serves draft settings for that call only. The reader is optional so the app boots
 * before the settings unit binds it; without one, or with a `null` configuration (disabled, shim mode, key
 * undecryptable), every step fails `AI_DISABLED`.
 */
@Injectable()
export class AiSdkChatModel implements ChatModelPort {
  private readonly options: AiProviderLayerOptions;

  constructor(
    @Optional()
    @Inject(AI_SETTINGS_READER)
    private readonly settings: AiSettingsReader | null,
    @Optional()
    @Inject(AI_PROVIDER_LAYER_OPTIONS)
    options?: AiProviderLayerOptions,
  ) {
    this.options = options ?? {};
  }

  async step(request: ChatModelStepRequest): Promise<ChatModelStepResult> {
    const config = this.settings
      ? await this.settings.resolveProviderConfig()
      : null;
    if (!config) {
      throw new AiProviderError('AI_DISABLED');
    }
    if (config.provider !== request.model.provider) {
      // The stored key belongs to the configured provider; it never goes to the one this conversation
      // was pinned to. The conversation is read-only after a provider change (ADR-0097, default 7).
      throw new AiProviderError('CONVERSATION_READ_ONLY');
    }
    return runModelStep(config, request, this.options);
  }

  toolResultsMessage(
    outcomes: readonly ChatModelToolOutcome[],
  ): ChatModelMessage {
    const message: ToolModelMessage = {
      role: 'tool',
      content: outcomes.map((outcome) => ({
        type: 'tool-result',
        toolCallId: outcome.toolCallId,
        toolName: outcome.toolName,
        output: toToolOutput(outcome),
      })),
    };
    return message;
  }

  userMessage(text: string): ChatModelMessage {
    const message: ModelMessage = { role: 'user', content: text };
    return message;
  }
}
