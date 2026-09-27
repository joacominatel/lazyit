import type {
  AiEffort,
  AiProviderKind,
  AiProviderOptions,
  AiUsage,
} from '@lazyit/shared';

/**
 * THE MODEL-CALL PORT (provider-and-runtime.md §6.1–§6.4). The runtime's agent loop depends on this, and
 * only the provider layer (`ai/providers/**`, the one place that imports `ai` / `@ai-sdk/*`) implements
 * it. One call = one model step: tools are passed WITHOUT an executor, so the model only proposes calls
 * and lazyit's loop decides what runs.
 */

/** A tool as the model sees it: the registry's listing, never its implementation. */
export interface ChatModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the input (`AiToolListing.inputSchema`). */
  inputSchema: Record<string, unknown>;
}

/**
 * A persisted, provider-replayable message, stored and replayed byte for byte (reasoning signatures and
 * `providerOptions` included — W1-B findings 5). Opaque to the runtime; only the provider layer reads it.
 * It is never a system message: the system prompt travels as `instructions`.
 */
export type ChatModelMessage = unknown;

export interface ChatModelStepRequest {
  /** The provider and model the conversation is pinned to. */
  model: { provider: AiProviderKind; modelId: string };
  /**
   * The conversation's own reasoning effort and provider options (#1373), when it set them; absent =
   * the instance settings. Already validated for the provider the conversation is pinned to.
   */
  effort?: AiEffort;
  providerOptions?: AiProviderOptions;
  /** The frozen system prompt. */
  instructions: string;
  /** The conversation so far, append-only. */
  messages: readonly ChatModelMessage[];
  tools: readonly ChatModelToolDefinition[];
  /**
   * Provider-native web search for this step (#1389; ADR-0097 decision 3 as amended 2026-09-24), when the
   * conversation was frozen with it. The provider runs the search on its own servers — lazyit makes no
   * request of its own — and the provider layer declares it only where the definition supports it.
   * `maxUses` caps searches per call where the provider takes a cap (Anthropic `max_uses`).
   */
  webSearch?: { maxUses: number };
  /** `none` on the final forced step, so the model summarizes instead of acting. */
  toolChoice: 'auto' | 'none';
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  /** Streamed text as it arrives (`message.delta`). */
  onTextDelta?: (text: string) => void;
}

/** A call the model proposed. The input is unvalidated: the executor validates it with the tool's schema. */
export interface ChatModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** A page the provider's web search drew on: an `http(s)` URL and its (other-authored) title. */
export interface ChatModelWebSource {
  url: string;
  title: string | null;
}

/** What the provider's native web search did during one step (#1389). */
export interface ChatModelWebSearch {
  /** Searches the provider ran (its server-side tool calls). */
  searches: number;
  /** The queries, where the provider reports them. Content the model wrote: never logged. */
  queries: string[];
  /** The sources the answer cites or was grounded on, `http(s)` only, deduplicated. */
  sources: ChatModelWebSource[];
}

export interface ChatModelStepResult {
  /** This step's messages, to append to the conversation as they are. */
  responseMessages: readonly ChatModelMessage[];
  /** The calls lazyit must answer. Provider-executed calls (the web search) are never here. */
  toolCalls: readonly ChatModelToolCall[];
  finishReason: string;
  usage: AiUsage;
  /** Present when the provider searched the web (or grounded the answer on sources) in this step. */
  webSearch?: ChatModelWebSearch;
  /**
   * The provider paused a long server-side turn (Anthropic `pause_turn`, a web search still going): the
   * loop continues with another step that sends the paused message back as it is.
   */
  paused?: boolean;
}

/** One tool call's answer, as the loop hands it back to the model. */
export interface ChatModelToolOutcome {
  toolCallId: string;
  toolName: string;
  /** The serialized `AiToolResult`. */
  output: unknown;
  isError: boolean;
}

export interface ChatModelPort {
  /** Run one model step. Provider failures are thrown classified (auth, rate limit, unavailable, …). */
  step(request: ChatModelStepRequest): Promise<ChatModelStepResult>;
  /** The single tool message carrying every result of a step, in the provider-replayable format. */
  toolResultsMessage(
    outcomes: readonly ChatModelToolOutcome[],
  ): ChatModelMessage;
  /** A user message in the provider-replayable format. */
  userMessage(text: string): ChatModelMessage;
}

/** DI token for the {@link ChatModelPort} implementation. */
export const CHAT_MODEL_PORT = Symbol('CHAT_MODEL_PORT');
