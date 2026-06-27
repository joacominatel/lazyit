import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  NotFoundException,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/require-permission.decorator';

/**
 * Directory holding the baked reporting-agent binaries (ADR-0074 §6). The API image's build stage
 * compiles `lazyit-agent-x64` / `lazyit-agent-arm64` into here. Overridable via env for dev/test;
 * absent in a non-Docker dev build → the route 404s with a clear message.
 */
const AGENT_BIN_DIR = process.env.AGENT_BIN_DIR ?? '/app/agent/bin';

const ARCHES = ['x64', 'arm64'] as const;
type Arch = (typeof ARCHES)[number];

/**
 * Token-gated download of the reporting agent binary (ADR-0074 §6). No anonymous binary surface — the
 * agent already holds the Service Account token, so this is gated on the same `infra:report` permission
 * as the report endpoint (the agent SA holds only that). The instance serves ITS OWN matching binary
 * (same-origin, version-locked, air-gapped-safe). Separate module from infra by design (#831).
 */
@ApiTags('agent')
@Controller('agent')
export class AgentDistController {
  @Get('download')
  @RequirePermission('infra:report')
  @ApiOperation({
    summary:
      'Download the lazyit reporting agent binary for the given arch (ADR-0074). MACHINE-intended: gated on infra:report (the agent SA token). Streams the baked Bun-compiled Linux executable; 404 if not bundled in this build.',
  })
  @ApiQuery({ name: 'arch', enum: ARCHES })
  @ApiOkResponse({
    description: 'The agent binary (application/octet-stream).',
  })
  download(@Query('arch') arch?: string): StreamableFile {
    if (!arch || !ARCHES.includes(arch as Arch)) {
      throw new NotFoundException(
        `unknown arch "${arch ?? ''}" — expected one of: ${ARCHES.join(', ')}`,
      );
    }
    const filename = `lazyit-agent-${arch}`;
    const path = join(AGENT_BIN_DIR, filename);
    if (!existsSync(path)) {
      throw new NotFoundException('agent binary not bundled in this build');
    }
    return new StreamableFile(createReadStream(path), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
