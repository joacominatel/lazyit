import { AsyncLocalStorage } from 'node:async_hooks';
import type { AiChannel } from '@lazyit/shared';

/**
 * The provenance of the AI tool call currently executing (tools-and-execution.md §10, R6). The executor
 * runs every dispatch inside this context, so the centralized history writers
 * (`AssetHistoryService.record`, `UserHistoryService.record`) can stamp `aiInvocationId` on the rows the
 * call produces — without any change to the domain services in between.
 *
 * The ACTOR is not here: the AI acts as the principal, so `ActorService` already attributes every row to
 * the real human or service account. This context only adds "it happened through this AI invocation".
 *
 * Kept free of Nest and Prisma imports: the history services depend on it, and it must never pull the AI
 * layer into their import graph.
 */
export interface AiInvocationContext {
  invocationId: string;
  channel: AiChannel;
  conversationId?: string;
  runId?: string;
}

const storage = new AsyncLocalStorage<AiInvocationContext>();

/** Run `fn` inside an AI invocation context. Everything it awaits — including Prisma transactions — sees it. */
export function runInAiInvocation<T>(
  context: AiInvocationContext,
  fn: () => T,
): T {
  return storage.run(Object.freeze({ ...context }), fn);
}

/** The AI invocation the current async flow belongs to, if any. */
export function currentAiInvocation(): AiInvocationContext | undefined {
  return storage.getStore();
}

/** The `aiInvocationId` to stamp on a history row, or undefined outside an AI tool call. */
export function currentAiInvocationId(): string | undefined {
  return storage.getStore()?.invocationId;
}
