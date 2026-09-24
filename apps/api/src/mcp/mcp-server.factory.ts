import { Injectable, Logger } from '@nestjs/common';
import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { AiToolService } from '../ai/core/ai-tool.service';
import { callKindOf } from '../ai/core/result-shaper';
import type { AiToolListing } from '../ai/core/tool-descriptor';
import { AiPromptService } from '../ai/prompt/ai-prompt.module';
import { isMcpListable, toMcpAnnotations } from './annotations';
import { toCallToolResult, toolError } from './error-mapper';
import { executionContextOf, type McpCaller } from './mcp-caller';
import { McpRateLimiter } from './mcp-rate-limit';
import { MCP_SERVER_INFO, MCP_TOOLS_LIST_TTL_MS } from './mcp.constants';

/**
 * A tool's input schema as the SDK wants it, WITHOUT the SDK's own validation: `tools/list` advertises
 * the catalog's JSON Schema, and every argument object is handed through unchanged, so the AI core
 * validates it with the tool's zod schema — the one validation, with the same `INVALID_INPUT` result on
 * every channel (the MCP spec: input errors are tool results with `isError`, so the model can correct
 * them). Only an object is accepted; the SDK already answers a malformed `tools/call` with -32602.
 */
export function advertisedSchema(
  jsonSchema: Record<string, unknown>,
): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'lazyit',
      validate: (value: unknown) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? { value: value as Record<string, unknown> }
          : { issues: [{ message: 'The arguments must be an object' }] },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

/**
 * Builds the per-request MCP server (ADR-0097 decision 9; mcp-and-oauth.md §5.3; F5, F7, F11, F12). The
 * SDK's `createMcpHandler` calls it once per HTTP request, so every request lists and runs tools as its
 * own verified caller — stateless, no session, nothing shared between callers.
 *
 *   - **Listing** — exactly what `AiToolService.list` returns for the caller on the `MCP` channel under
 *     its ceiling (the scopes, or the Service Account's AI access), i.e. tools whose channel admits MCP,
 *     whose class the ceiling covers, whose route admits the principal kind and whose permission the
 *     principal holds NOW (INV-AI-2, INV-MCP-2). `navigate` is never listed. Deterministic order (by
 *     name); `tools/list` carries a private, one-minute cache hint; `listChanged: false`.
 *   - **Calling** — the rate limits, then `AiToolService.invoke` with the same context: core re-checks the
 *     principal, `ai:connect`, the channel and the ceiling on every call, the route's own guards and
 *     pipes run inside the dispatch, and writes go through the permanent ledger. Channel refusals (a
 *     critical application over MCP, CEO 2026-09-24) come back from the tool as `FORBIDDEN`.
 *   - **Annotations** from the tool class ({@link toMcpAnnotations}); **results and errors** through
 *     {@link toCallToolResult}.
 *   - **Instructions** — the domain primer, rendered from `LAZYIT_DOMAIN_PRIMER` (never hand-copied).
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);

  constructor(
    private readonly tools: AiToolService,
    private readonly prompt: AiPromptService,
    private readonly rateLimiter: McpRateLimiter,
  ) {}

  /** The tools this caller may see over MCP, in a deterministic order. */
  async listTools(caller: McpCaller): Promise<AiToolListing[]> {
    const listing = await this.tools.list(executionContextOf(caller));
    return listing
      .filter((tool) => isMcpListable(tool.class))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** A fresh server for one request. With no caller it serves no tools (fail closed). */
  async build(
    caller: McpCaller | null,
    requestId?: string,
  ): Promise<McpServer> {
    const server = new McpServer(
      { ...MCP_SERVER_INFO },
      {
        instructions: this.prompt.mcpInstructions(),
        capabilities: { tools: { listChanged: false } },
        cacheHints: {
          'tools/list': { ttlMs: MCP_TOOLS_LIST_TTL_MS, cacheScope: 'private' },
        },
      },
    );
    if (!caller) return server;

    for (const tool of await this.listTools(caller)) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: advertisedSchema(tool.inputSchema),
          annotations: toMcpAnnotations(tool),
        },
        (args: Record<string, unknown>) =>
          this.call(caller, tool, args, requestId),
      );
    }
    return server;
  }

  /** One `tools/call`. Never throws: every failure is an `isError` result. */
  async call(
    caller: McpCaller,
    tool: Pick<AiToolListing, 'name' | 'class'>,
    args: Record<string, unknown>,
    requestId?: string,
  ): Promise<CallToolResult> {
    const mutation = callKindOf(tool.class) === 'mutation';
    if (!this.rateLimiter.call(caller.rateKey, mutation)) {
      return toolError(
        'RATE_LIMITED',
        mutation
          ? 'Too many changes through this connection in the last minute.'
          : 'Too many tool calls through this connection in the last minute.',
        { hint: 'Wait a minute, then retry.' },
      );
    }
    try {
      const result = await this.tools.invoke(
        tool.name,
        args,
        executionContextOf(caller, requestId),
      );
      return toCallToolResult(result, requestId);
    } catch (err) {
      // Core returns failures as results; an escape here is a bug. Never leak it to the client.
      this.logger.error(
        `MCP tool ${tool.name} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return toolError('INTERNAL', 'The tool failed unexpectedly.', {
        ...(requestId ? { requestId } : {}),
      });
    }
  }
}
