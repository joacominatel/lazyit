import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from 'ai';

import type {
  StructuredExtractionRequest,
  StructuredExtractionResult,
} from '../core/ports/structured-extraction.port';
import { AiStructuredOutputError } from './ai-provider.error';
import {
  DEFAULT_PROVIDER_MAX_RETRIES,
  refuseDownload,
  resolveModel,
  toAiUsage,
  type AiProviderLayerOptions,
} from './model-step';
import { classifyProviderError } from './provider-errors';
import type { ProviderConfig } from './provider.types';

/**
 * One structured-output call over one file (ADR-0099 §11, #1477): `generateText` with `Output.object`, the
 * file as an inline `file` part, and NO `tools` key — no lazyit tool is declared, so the model can only
 * answer with data in the schema's shape (a provider's own synthetic JSON tool, if it uses one for structured
 * output, has no executor). Everything else is the chat step's posture:
 *   - the provider definition builds the model over the egress-guarded fetch (INV-AI-7), with the key checked
 *     before any I/O so the SDK's environment fallback never applies;
 *   - `experimental_download` refuses every URL the SDK would fetch outside the guard;
 *   - telemetry is off, and the SDK error is classified — its message and request body (the document) never
 *     reach a log or the caller (ADR-0031).
 * A model answer that does not fit the schema throws {@link AiStructuredOutputError} with its usage.
 */
export async function runStructuredExtraction<T>(
  config: ProviderConfig,
  request: StructuredExtractionRequest<T>,
  options: AiProviderLayerOptions = {},
): Promise<StructuredExtractionResult<T>> {
  const modelId = request.model.modelId;
  // `auto`: there are no tools, so the tool-choice adaptation a definition may apply is a no-op here.
  const { definition, model } = resolveModel(config, modelId, 'auto', options);
  const settings = definition.callSettings(config, modelId);
  try {
    const result = await generateText({
      model,
      instructions: request.instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            {
              type: 'file',
              data: request.file.data,
              mediaType: request.file.mediaType,
            },
          ],
        },
      ],
      output: Output.object({
        schema: request.schema,
        name: request.schemaName,
      }),
      maxOutputTokens: request.maxOutputTokens,
      ...(settings.temperature !== undefined
        ? { temperature: settings.temperature }
        : {}),
      providerOptions: settings.providerOptions as never,
      abortSignal: request.abortSignal,
      maxRetries: options.maxRetries ?? DEFAULT_PROVIDER_MAX_RETRIES,
      experimental_download: refuseDownload,
      telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
    });
    return {
      output: result.output,
      usage: toAiUsage(result.usage),
      finishReason: result.finishReason,
    };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      throw new AiStructuredOutputError(toAiUsage(err.usage));
    }
    if (
      NoOutputGeneratedError.isInstance(err) &&
      !request.abortSignal?.aborted
    ) {
      throw new AiStructuredOutputError(toAiUsage(undefined));
    }
    throw classifyProviderError(
      err,
      definition.errorPatterns,
      request.abortSignal,
    );
  }
}
