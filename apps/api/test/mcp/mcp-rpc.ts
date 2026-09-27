/**
 * Builds MCP requests for Jest. A request reaches the SDK's 2026-07-28 ("modern") path only with the full
 * envelope — the `mcp-protocol-version` / `mcp-method` / `mcp-name` headers AND the `_meta` protocol
 * version, client info and capabilities (W1-B compatibility spike) — otherwise it is served by the
 * stateless 2025-era leg, which would silently test the wrong path. Test support only (outside the build).
 */

import type { Response } from 'supertest';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';

let nextId = 0;

export interface McpRpc {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A 2026-07-28 request for `method` (`name` is the target of `tools/call`). */
export function modern(
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
): McpRpc {
  nextId += 1;
  return {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
    },
    body: {
      jsonrpc: '2.0',
      id: nextId,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': {
            name: 'jest',
            version: '0.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  };
}

export const toolsList = (): McpRpc => modern('tools/list');

export const toolsCall = (
  name: string,
  args: Record<string, unknown>,
): McpRpc => modern('tools/call', { name, arguments: args }, name);

/** A 2025-era `tools/list` (no envelope): the stateless legacy leg. */
export function legacyToolsList(): McpRpc {
  nextId += 1;
  return {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LEGACY,
    },
    body: { jsonrpc: '2.0', id: nextId, method: 'tools/list', params: {} },
  };
}

/** The JSON-RPC payload of a response, whether it came as JSON or as one SSE `data:` frame. */
export function payloadOf(res: Response): Record<string, any> {
  if (res.body && typeof res.body === 'object' && 'jsonrpc' in res.body) {
    return res.body as Record<string, any>;
  }
  const text = res.text ?? '';
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text) as Record<
    string,
    any
  >;
}
