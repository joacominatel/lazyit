import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AiToolErrorCode, AiToolResult } from '@lazyit/shared';
import { MCP_RESULT_MAX_CHARS } from './mcp.constants';

/**
 * An `AiToolResult` as an MCP `CallToolResult` (mcp-and-oauth.md §5.3 "Error shape"; the MCP spec: tool
 * errors that the model can correct are results with `isError: true`, not JSON-RPC errors):
 *   - success → `structuredContent` `{ ok, kind, data, summary?, truncated?, mutated, entityRefs }` and
 *     its serialized JSON mirrored as the one text block (back-compat for clients that ignore
 *     `structuredContent`);
 *   - failure → `isError: true`, `structuredContent` `{ ok: false, error: { code, message, hint?,
 *     requestId? } }`, and the message (plus hint) as text. Codes are the core's closed set
 *     (`INVALID_INPUT`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`, …); an
 *     `INTERNAL` never carries internals — core already replaced the message — and gains the request id
 *     for the operator's logs (ADR-0031).
 *
 * Unknown tools and malformed JSON-RPC stay JSON-RPC errors: the SDK answers those before any handler.
 */

/** A tool-level error in MCP form. */
export function toolError(
  code: AiToolErrorCode,
  message: string,
  extra: { hint?: string; requestId?: string } = {},
): CallToolResult {
  const error = {
    code,
    message,
    ...(extra.hint !== undefined ? { hint: extra.hint } : {}),
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: extra.hint ? `${message}\n${extra.hint}` : message,
      },
    ],
    structuredContent: { ok: false, error },
  };
}

export function toCallToolResult(
  result: AiToolResult,
  requestId?: string,
): CallToolResult {
  if (!result.ok) {
    return toolError(result.error.code, result.error.message, {
      ...(result.error.hint !== undefined ? { hint: result.error.hint } : {}),
      ...(result.error.code === 'INTERNAL' && requestId ? { requestId } : {}),
    });
  }
  const structured: Record<string, unknown> = {
    ok: true,
    kind: result.kind,
    data: result.data ?? null,
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    mutated: result.mutated,
    entityRefs: result.entityRefs,
  };
  const text = JSON.stringify(structured);
  if (text.length > MCP_RESULT_MAX_CHARS) {
    // The side effect (if any) already happened: say so, so the model does not repeat a write.
    return toolError(
      'INVALID_INPUT',
      result.mutated
        ? 'The action succeeded, but its result is too large to return.'
        : 'The result is too large to return.',
      {
        hint: result.mutated
          ? 'Do not repeat the action; read the affected record with a narrower query instead.'
          : 'Narrow the query (add filters) or page through it with a smaller limit and an offset.',
      },
    );
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}
