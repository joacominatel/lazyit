import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../auth/public.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import { PluginDistributionService } from './plugin-distribution.service';

const ZIP_FILENAME = 'lazyit-plugin.zip';

function etagOf(sha256: string): string {
  return `"${sha256}"`;
}

/** `If-None-Match` matches the ETag (a list, weak forms and `*` included). */
function notModified(req: Request, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);
}

/**
 * The Claude Code plugin (ADR-0097 decision 10, R8; mcp-and-oauth.md §5.1, §5.5). Browser path
 * `/api/ai/claude-code/…` (Caddy strips `/api`).
 *
 *   - `GET /ai/claude-code/plugin.zip` — human session + `ai:connect`, while MCP is enabled. `no-store`:
 *     on `lan` the origin inside may come from the requester's own `Host`.
 *   - `GET /ai/claude-code/marketplace.json`, `GET /ai/claude-code/lazyit-plugin.zip` — PUBLIC, only while
 *     MCP is enabled on a pinned-HTTPS instance; 404 otherwise. `no-cache` + a strong ETag (the archive's
 *     SHA-256), so clients revalidate and a switched-off instance stops answering at once.
 *
 * Responses are written with `@Res()` for exact bytes and headers; errors still go through the exception
 * filters.
 */
@ApiTags('ai')
@Controller('ai/claude-code')
export class PluginDistributionController {
  constructor(private readonly distribution: PluginDistributionService) {}

  @Get('plugin.zip')
  @RequirePermission('ai:connect')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary: 'Download the Claude Code plugin for this instance (ai:connect)',
    description:
      'A zip with the lazyit skill, the domain primer, the generated tool index and an `.mcp.json` for ' +
      '`<origin>/mcp` — OAuth on HTTPS instances, a personal-token `userConfig` placeholder on `lan`. 404 while MCP is off.',
  })
  @ApiProduces('application/zip')
  async download(@Req() req: Request, @Res() res: Response): Promise<void> {
    const plugin = await this.distribution.authenticatedArchive(req.headers);
    res
      .status(200)
      .set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${ZIP_FILENAME}"`,
        'Cache-Control': 'private, no-store',
        ETag: etagOf(plugin.sha256),
      })
      .end(plugin.zip);
  }

  @Get('marketplace.json')
  @Public()
  @ApiExcludeEndpoint()
  async marketplace(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { body, sha256 } = await this.distribution.publicMarketplace();
    const etag = etagOf(sha256);
    res.set({ 'Cache-Control': 'no-cache', ETag: etag });
    if (notModified(req, etag)) {
      res.status(304).end();
      return;
    }
    res
      .status(200)
      .type('application/json')
      .end(`${JSON.stringify(body, null, 2)}\n`);
  }

  @Get(ZIP_FILENAME)
  @Public()
  @ApiExcludeEndpoint()
  async publicArchive(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const archive = await this.distribution.publicArchive();
    const etag = etagOf(archive.sha256);
    res.set({ 'Cache-Control': 'no-cache', ETag: etag });
    if (notModified(req, etag)) {
      res.status(304).end();
      return;
    }
    res
      .status(200)
      .set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${ZIP_FILENAME}"`,
      })
      .end(archive.zip);
  }
}
