/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed any */
import type { AiToolResult } from '@lazyit/shared';
import { toCallToolResult, toolError } from './error-mapper';
import { MCP_RESULT_MAX_CHARS } from './mcp.constants';

describe('AiToolResult → MCP CallToolResult (mcp-and-oauth.md §5.3 "Error shape")', () => {
  it('mirrors a success as structuredContent and its JSON text', () => {
    const result: AiToolResult = {
      ok: true,
      kind: 'read',
      data: { id: 'a1' },
      summary: 'One asset',
      truncated: { shown: 1, total: 3, nextOffset: 1 },
      mutated: false,
      entityRefs: [{ type: 'asset', id: 'a1', op: 'updated' }],
    };
    const mapped = toCallToolResult(result);
    expect(mapped.isError).toBeUndefined();
    expect(mapped.structuredContent).toEqual({
      ok: true,
      kind: 'read',
      data: { id: 'a1' },
      summary: 'One asset',
      truncated: { shown: 1, total: 3, nextOffset: 1 },
      mutated: false,
      entityRefs: [{ type: 'asset', id: 'a1', op: 'updated' }],
    });
    expect(mapped.content).toEqual([
      { type: 'text', text: JSON.stringify(mapped.structuredContent) },
    ]);
  });

  it.each([
    'INVALID_INPUT',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
  ] as const)(
    'maps a %s failure to isError with its code and safe message',
    (code) => {
      const mapped = toCallToolResult({
        ok: false,
        kind: 'mutation',
        error: { code, status: 400, message: 'Nope', hint: 'Try x' },
        mutated: false,
        entityRefs: [],
      });
      expect(mapped).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Nope\nTry x' }],
        structuredContent: {
          ok: false,
          error: { code, message: 'Nope', hint: 'Try x' },
        },
      });
    },
  );

  it('adds the request id to INTERNAL only — and never an HTTP status or internals', () => {
    const mapped = toCallToolResult(
      {
        ok: false,
        kind: 'read',
        error: {
          code: 'INTERNAL',
          status: 500,
          message: 'The tool failed unexpectedly.',
        },
        mutated: false,
        entityRefs: [],
      },
      'req-1',
    );
    expect(mapped.structuredContent).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'The tool failed unexpectedly.',
        requestId: 'req-1',
      },
    });
    const notFound = toCallToolResult(
      {
        ok: false,
        kind: 'read',
        error: { code: 'NOT_FOUND', message: 'x' },
        mutated: false,
        entityRefs: [],
      },
      'req-1',
    );
    expect(JSON.stringify(notFound)).not.toContain('req-1');
  });

  it('answers isError guidance for a result past the backstop — and says a write already happened', () => {
    const big = 'x'.repeat(MCP_RESULT_MAX_CHARS);
    const read = toCallToolResult({
      ok: true,
      kind: 'read',
      data: big,
      mutated: false,
      entityRefs: [],
    });
    expect(read).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'INVALID_INPUT', hint: expect.stringMatching(/Narrow/) },
      },
    });
    const write = toCallToolResult({
      ok: true,
      kind: 'mutation',
      data: big,
      mutated: true,
      entityRefs: [],
    });
    expect(write).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          message: expect.stringMatching(/succeeded/),
          hint: expect.stringMatching(/Do not repeat/),
        },
      },
    });
  });

  it('builds a bare tool error', () => {
    expect(toolError('RATE_LIMITED', 'Slow down')).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Slow down' }],
      structuredContent: {
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Slow down' },
      },
    });
  });
});
