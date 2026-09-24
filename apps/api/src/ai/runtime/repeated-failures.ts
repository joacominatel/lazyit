import type { AiToolErrorCode, AiToolResult } from '@lazyit/shared';
import { canonicalJson } from '../core/pending-action';

/**
 * How many times a tool call may fail the same way in one run before the loop stops offering that
 * retry (#1403; provider-and-runtime.md §6.1).
 */
export const AI_REPEATED_FAILURE_LIMIT = 2;

/** A transient refusal is not the model's mistake: retrying the same call later is legitimate. */
const TRANSIENT: ReadonlySet<AiToolErrorCode> = new Set(['RATE_LIMITED']);

type FailedResult = Extract<AiToolResult, { ok: false }>;

export interface RepeatedFailureRefusal {
  code: AiToolErrorCode;
  message: string;
  hint: string;
}

/**
 * The loop's guard against a model repeating a failing tool call (#1403). One per loop pass (a run
 * resumed after a pause starts a fresh one); in memory only, never persisted. For every tool:
 *   - a call whose tool AND canonical input already failed {@link AI_REPEATED_FAILURE_LIMIT} times is
 *     not run again: it is answered with a refusal telling the model to stop;
 *   - once a tool has failed with the same error {@link AI_REPEATED_FAILURE_LIMIT} times (whatever the
 *     input), that result carries the same stop hint.
 * An interaction tool (`request_input`) is told to ask the user in plain text instead. `RATE_LIMITED`
 * is transient and never counted.
 */
export class RepeatedFailureGuard {
  private readonly byInput = new Map<string, number>();
  private readonly byError = new Map<string, number>();

  /** The refusal for a call that already failed identically too often, or null to run it. */
  check(
    toolName: string,
    input: unknown,
    options: { awaitsInput?: boolean } = {},
  ): RepeatedFailureRefusal | null {
    const count = this.byInput.get(inputKey(toolName, input)) ?? 0;
    if (count < AI_REPEATED_FAILURE_LIMIT) return null;
    return {
      code: 'INVALID_INPUT',
      message: `Not run: this exact ${toolName} call already failed ${count} times in this turn`,
      hint: stopHint(toolName, options.awaitsInput === true),
    };
  }

  /**
   * Record a call's result. A failure is counted; once the same failure repeats, the result the model
   * sees gains the stop hint. A success is returned unchanged.
   */
  record(
    toolName: string,
    input: unknown,
    result: AiToolResult,
    options: { awaitsInput?: boolean } = {},
  ): AiToolResult {
    if (result.ok || TRANSIENT.has(result.error.code)) return result;
    const byInput = bump(this.byInput, inputKey(toolName, input));
    const byError = bump(this.byError, errorKey(toolName, result));
    if (Math.max(byInput, byError) < AI_REPEATED_FAILURE_LIMIT) return result;
    return withHint(result, stopHint(toolName, options.awaitsInput === true));
  }
}

function inputKey(toolName: string, input: unknown): string {
  let canonical: string;
  try {
    canonical = canonicalJson(input ?? null);
  } catch {
    canonical = String(input);
  }
  return `${toolName}\u0000${canonical}`;
}

function errorKey(toolName: string, result: FailedResult): string {
  return `${toolName}\u0000${result.error.code}\u0000${result.error.message}`;
}

function bump(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

function stopHint(toolName: string, awaitsInput: boolean): string {
  return awaitsInput
    ? `This has failed the same way ${AI_REPEATED_FAILURE_LIMIT} times. Stop calling ${toolName}: ` +
        'ask the user for the data in plain text in your reply instead.'
    : `This has failed the same way ${AI_REPEATED_FAILURE_LIMIT} times. Do not call ${toolName} again ` +
        'with the same arguments: fix what the error names, take another approach, or tell the user ' +
        'what is blocking you.';
}

function withHint(result: FailedResult, hint: string): FailedResult {
  const current = result.error.hint;
  if (current?.includes(hint)) return result;
  return {
    ...result,
    error: { ...result.error, hint: current ? `${current} ${hint}` : hint },
  };
}
