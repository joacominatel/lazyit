import {
  All,
  Controller,
  Logger,
  type OnModuleDestroy,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { McpAuthGuard, type McpRequest } from './mcp-auth.guard';
import { callerOf } from './mcp-caller';
import { McpServerFactory } from './mcp-server.factory';

/** The request id pino-http assigned (ADR-0031), for provenance and `INTERNAL` error answers. */
function requestIdOf(req: McpRequest): string | undefined {
  const id = (req as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number'
    ? String(id)
    : undefined;
}

/**
 * `/mcp` — lazyit's MCP resource server (ADR-0097 decision 9; mcp-and-oauth.md F5, §5.1, §5.3). A public
 * path: Caddy routes `/mcp` to the API unprefixed.
 *
 * The official SDK v2's stateless `createMcpHandler` runs inside Nest (DI, pino request logging and the
 * request id stay). It serves the 2026-07-28 revision and, statelessly, 2025-era clients; it mints no
 * `Mcp-Session-Id`, answers GET/DELETE with 405, and answers tool calls with a single JSON body
 * (`responseMode: 'json'` — no long-lived streams through the proxy). The SDK performs no authentication
 * of its own: `authInfo` is pure pass-through.
 *
 * `@Public()` towards the global session guards — a session JWT is never accepted here — and
 * `@UseGuards(McpAuthGuard)` is the only way in; the handler fails closed when the guard's verified
 * caller is absent. `mcp.controller.spec.ts` pins both.
 */
@ApiExcludeController()
@Public()
@UseGuards(McpAuthGuard)
@Controller()
export class McpController implements OnModuleDestroy {
  private readonly logger = new Logger(McpController.name);
  private readonly handler = createMcpHandler(
    ({ authInfo, requestInfo }) =>
      this.factory.build(
        callerOf(authInfo),
        requestInfo?.headers.get('x-request-id') ?? undefined,
      ),
    {
      responseMode: 'json',
      onerror: (error) => {
        this.logger.warn(`MCP request refused or failed: ${error.message}`);
      },
    },
  );
  private readonly node = toNodeHandler(this.handler);

  constructor(private readonly factory: McpServerFactory) {}

  @All('mcp')
  async handle(@Req() req: McpRequest, @Res() res: Response): Promise<void> {
    if (!req.mcpCaller || !req.auth || callerOf(req.auth) !== req.mcpCaller) {
      throw new UnauthorizedException();
    }
    const requestId = requestIdOf(req);
    if (requestId && !req.headers['x-request-id']) {
      req.headers['x-request-id'] = requestId;
    }
    await this.node(req, res, req.body);
  }

  async onModuleDestroy(): Promise<void> {
    await this.handler.close();
  }
}
