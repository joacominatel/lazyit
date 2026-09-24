/**
 * AI assistant constants (ADR-0097; docs/ai-assistant/_synthesis.md §4, provider-and-runtime.md §6.4, §8).
 * Wire vocabularies (channels, classes, statuses, error codes) live in `@lazyit/shared`; these are the
 * API-internal names and limits.
 */

/** The BullMQ queue every chat and headless run executes on. A job carries only `{ runId }`. */
export const AI_RUN_QUEUE = 'ai-run';

/** The two job kinds on {@link AI_RUN_QUEUE}: a fresh run, and the resume after approvals are decided. */
export const AI_RUN_JOB_START = 'start';
export const AI_RUN_JOB_RESUME = 'resume';

/**
 * The version of the frozen system prompt. Stored on every conversation (`AiConversation.promptVersion`);
 * a conversation pinned to another version becomes read-only. Bump it whenever the primer or the
 * system-prompt builder changes what the model is told.
 */
export const AI_PROMPT_VERSION = 5;

/** A tool result is truncated once, at write time, past this many serialized characters (§4.3). */
export const AI_TOOL_RESULT_MAX_CHARS = 20_000;

/** Pagination inside list tools (§4.3): default and maximum page size. */
export const AI_TOOL_LIST_DEFAULT_LIMIT = 20;
export const AI_TOOL_LIST_MAX_LIMIT = 50;
