import type { AiProviderKind, AiUsage } from '@lazyit/shared';
import type { z } from 'zod';

/**
 * THE STRUCTURED-EXTRACTION PORT (ADR-0099 §11, #1477): one model call that reads ONE file and answers with
 * an object of a given zod shape. It is the chat model port's sibling, not part of it: the chat runtime never
 * extracts, and an extraction is never a chat step. Only the provider layer (`ai/providers/**`) implements it,
 * through the same provider definitions and the same egress-guarded fetch.
 *
 * The call carries NO tools — not even declared ones — so a document cannot make the model act: whatever the
 * file says, the only possible answer is data in the schema's shape (INV-AI-4). The SDK never downloads a URL
 * on its behalf (INV-AI-7): the bytes travel inline.
 */

/** The file the model reads: its bytes (inline, never a URL) and its server-sniffed media type. */
export interface StructuredExtractionFile {
  data: Uint8Array;
  mediaType: string;
  filename?: string;
}

export interface StructuredExtractionRequest<T> {
  /** The configured provider and model — the call fails `CONVERSATION_READ_ONLY` if the settings moved on. */
  model: { provider: AiProviderKind; modelId: string };
  /** The fixed instructions (the extraction rules). Never content from the file. */
  instructions: string;
  /** The user turn's text that accompanies the file. */
  prompt: string;
  file: StructuredExtractionFile;
  /** The shape of the answer; the SDK validates the model's output against it. */
  schema: z.ZodType<T>;
  /** A name for the output, which some providers pass to the model as the schema name. */
  schemaName: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export interface StructuredExtractionResult<T> {
  output: T;
  usage: AiUsage;
  finishReason: string;
}

export interface StructuredExtractionPort {
  /**
   * Run the extraction. Throws `AiProviderError` classified (auth, rate limit, unavailable, cancelled…), or
   * `AiStructuredOutputError` when the model answered nothing that fits the schema (its usage attached).
   */
  extractStructured<T>(
    request: StructuredExtractionRequest<T>,
  ): Promise<StructuredExtractionResult<T>>;
}

/** DI token for the {@link StructuredExtractionPort} implementation. */
export const STRUCTURED_EXTRACTION_PORT = Symbol('STRUCTURED_EXTRACTION_PORT');
