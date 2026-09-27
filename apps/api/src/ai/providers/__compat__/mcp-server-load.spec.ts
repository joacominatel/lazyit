/**
 * Compatibility regression (epic #1315 W1-B item f): the MCP TypeScript SDK v2 server loads under the
 * CommonJS Jest runtime (its `require` build — no transform needed) and a stateless `createMcpHandler`
 * answers `tools/list` in-process, both on its web-standard face and through `toNodeHandler`, the shape
 * the Nest controller will mount (mcp-and-oauth.md F5). The tool is declared from a JSON Schema, as the
 * lazyit tool catalog provides it, and the verified `authInfo` reaches the per-request factory.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type AuthInfo,
} from '@modelcontextprotocol/server';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

const authInfo: AuthInfo = {
  token: 'opaque',
  clientId: 'claude-code',
  scopes: ['lazyit'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function buildHandler(seen: Array<AuthInfo | undefined>) {
  return createMcpHandler(({ authInfo: caller }) => {
    seen.push(caller);
    const server = new McpServer({ name: 'lazyit', version: '0.0.0' });
    server.registerTool(
      'lazyit_search',
      {
        description: 'Search lazyit.',
        inputSchema: fromJsonSchema<{ query: string }>({
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        }),
        annotations: { readOnlyHint: true },
      },
      ({ query }) =>
        Promise.resolve({ content: [{ type: 'text', text: query }] }),
    );
    return server;
  });
}

function modernToolsList(): { headers: Record<string, string>; body: string } {
  return {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN,
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': {
            name: 'jest',
            version: '0.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  };
}

const expectedTool = {
  name: 'lazyit_search',
  description: 'Search lazyit.',
  inputSchema: expect.objectContaining({
    type: 'object',
    required: ['query'],
  }) as unknown,
  annotations: { readOnlyHint: true },
};

describe('MCP SDK v2 server under CommonJS Jest', () => {
  it(`answers a ${MODERN} tools/list through handler.fetch and passes authInfo to the factory`, async () => {
    const seen: Array<AuthInfo | undefined> = [];
    const handler = buildHandler(seen);
    const { headers, body } = modernToolsList();

    const res = await handler.fetch(
      new Request('https://lazyit.test/mcp', { method: 'POST', headers, body }),
      {
        authInfo,
      },
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      id: number;
      result: { tools: unknown[] };
    };
    expect(payload.id).toBe(1);
    expect(payload.result.tools).toEqual([expectedTool]);
    expect(seen).toEqual([authInfo]);
    await handler.close();
  });

  describe('through toNodeHandler on a node:http server', () => {
    const seen: Array<AuthInfo | undefined> = [];
    const handler = buildHandler(seen);
    let server: http.Server;
    let url: string;

    beforeAll((done) => {
      const node = toNodeHandler(handler);
      server = http.createServer((req, res) => {
        // What the route-scoped MCP guard will do after verifying the bearer token.
        Object.assign(req, { auth: authInfo });
        void node(req, res);
      });
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
        done();
      });
    });

    afterAll(async () => {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
    });

    it('answers a modern tools/list and forwards req.auth as authInfo', async () => {
      seen.length = 0;
      const { headers, body } = modernToolsList();

      const res = await fetch(url, { method: 'POST', headers, body });

      expect(res.status).toBe(200);
      const payload = (await res.json()) as { result: { tools: unknown[] } };
      expect(payload.result.tools).toEqual([expectedTool]);
      expect(seen).toEqual([authInfo]);
    });

    it(`answers a ${LEGACY}-era tools/list statelessly (the default legacy fallback)`, async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': LEGACY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      const data = text.split('\n').find((line) => line.startsWith('data: '));
      const payload = JSON.parse(data?.slice('data: '.length) ?? text) as {
        id: number;
        result: { tools: unknown[] };
      };
      expect(payload.id).toBe(2);
      expect(payload.result.tools).toEqual([expectedTool]);
    });
  });
});
