import type { AiToolResult } from '@lazyit/shared';
import { errorResult } from '../core/result-shaper';
import {
  AI_REPEATED_FAILURE_LIMIT,
  RepeatedFailureGuard,
} from './repeated-failures';

const TOOL = 'request_input';
const INPUT = { title: 'T', reason: 'R', fields: [{ key: 'a' }] };
const invalid = (message = 'fields.0: bad') =>
  errorResult('navigate', { code: 'INVALID_INPUT', message });
const hintOf = (result: AiToolResult) =>
  result.ok ? undefined : result.error.hint;

describe('RepeatedFailureGuard (#1403)', () => {
  it('lets the first failure through untouched', () => {
    const guard = new RepeatedFailureGuard();
    expect(guard.check(TOOL, INPUT)).toBeNull();
    const first = invalid();
    expect(guard.record(TOOL, INPUT, first)).toBe(first);
  });

  it('after the same failure twice, tells an interaction tool to ask in plain text, and stops the identical third call', () => {
    const guard = new RepeatedFailureGuard();
    guard.record(TOOL, INPUT, invalid(), { awaitsInput: true });
    const second = guard.record(TOOL, INPUT, invalid(), { awaitsInput: true });
    expect(AI_REPEATED_FAILURE_LIMIT).toBe(2);
    expect(hintOf(second)).toBe(
      'This has failed the same way 2 times. Stop calling request_input: ask the user for the data in ' +
        'plain text in your reply instead.',
    );
    // Key order does not make it a different call.
    const reordered = { fields: [{ key: 'a' }], reason: 'R', title: 'T' };
    expect(guard.check(TOOL, reordered, { awaitsInput: true })).toEqual({
      code: 'INVALID_INPUT',
      message:
        'Not run: this exact request_input call already failed 2 times in this turn',
      // #1384: the same refusal as a code the web localizes.
      messageSentences: [
        {
          code: 'refusal.repeatedFailure',
          params: { tool: 'request_input', count: 2 },
        },
      ],
      hint: hintOf(second),
    });
  });

  it('counts the same error across different inputs, for any tool', () => {
    const guard = new RepeatedFailureGuard();
    guard.record('asset_search', { q: 'a' }, invalid('q: too short'));
    const second = guard.record(
      'asset_search',
      { q: 'b' },
      invalid('q: too short'),
    );
    expect(hintOf(second)).toMatch(
      /^This has failed the same way 2 times\. Do not call asset_search again with the same arguments/,
    );
    // A different input is still run: only the identical call is refused before running.
    expect(guard.check('asset_search', { q: 'c' })).toBeNull();
  });

  it('keeps the tool’s own hint and never repeats the stop hint', () => {
    const guard = new RepeatedFailureGuard();
    const own = errorResult('read', {
      code: 'NOT_FOUND',
      message: 'No asset',
      hint: 'Search first.',
    });
    guard.record('asset_get', { id: 'x' }, own);
    const second = guard.record('asset_get', { id: 'x' }, own);
    const third = guard.record('asset_get', { id: 'x' }, second);
    expect(hintOf(second)).toMatch(/^Search first\. This has failed/);
    expect(hintOf(third)).toBe(hintOf(second));
  });

  it('does not count a success, a different tool, or a transient rate limit', () => {
    const guard = new RepeatedFailureGuard();
    const limited = errorResult('read', {
      code: 'RATE_LIMITED',
      message: 'Too many tool calls',
    });
    guard.record(TOOL, INPUT, limited);
    guard.record(TOOL, INPUT, limited);
    expect(guard.check(TOOL, INPUT)).toBeNull();
    guard.record(TOOL, INPUT, invalid());
    guard.record('other_tool', INPUT, invalid());
    expect(guard.check(TOOL, INPUT)).toBeNull();
    const ok: AiToolResult = {
      ok: true,
      kind: 'read',
      data: null,
      mutated: false,
      entityRefs: [],
    };
    expect(guard.record(TOOL, INPUT, ok)).toBe(ok);
  });
});
