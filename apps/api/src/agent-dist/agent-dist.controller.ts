import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Header,
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
 * compiles `lazyit-agent-{x64,x64-baseline,arm64}` and their `.sha256` files into here. Overridable
 * via env for dev/test; absent in a non-Docker dev build → the routes 404 with a clear message.
 */
const AGENT_BIN_DIR = process.env.AGENT_BIN_DIR ?? '/app/agent/bin';

/**
 * `x64-baseline` is the pre-AVX2 x86-64 build (#1137). Bun's ordinary `bun-linux-x64` target assumes
 * AVX2 (Haswell, 2013), so a pre-Haswell host — or a vSphere cluster whose EVC baseline masks the
 * flag — dies with SIGILL, in the worst case months later when a vMotion lands the VM on older
 * silicon. `install.sh` reads `/proc/cpuinfo` and asks for this artifact when the flag is absent.
 */
const ARCHES = ['x64', 'x64-baseline', 'arm64'] as const;
type Arch = (typeof ARCHES)[number];

/** The arch, validated against the closed list — the only thing that ever reaches `join()`. */
function requireArch(arch?: string): Arch {
  if (!arch || !ARCHES.includes(arch as Arch)) {
    throw new NotFoundException(
      `unknown arch "${arch ?? ''}" — expected one of: ${ARCHES.join(', ')}`,
    );
  }
  return arch as Arch;
}

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
      'Download the lazyit reporting agent binary for the given arch (ADR-0074). MACHINE-intended: gated on infra:report (the agent SA token). Streams the baked Bun-compiled Linux executable; 404 if not bundled in this build. `x64-baseline` is the pre-AVX2 build for older or EVC-masked x86-64 hosts.',
  })
  @ApiQuery({ name: 'arch', enum: ARCHES })
  @ApiOkResponse({
    description: 'The agent binary (application/octet-stream).',
  })
  download(@Query('arch') arch?: string): StreamableFile {
    const filename = `lazyit-agent-${requireArch(arch)}`;
    const path = join(AGENT_BIN_DIR, filename);
    if (!existsSync(path)) {
      throw new NotFoundException('agent binary not bundled in this build');
    }
    return new StreamableFile(createReadStream(path), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * The sha256 of the binary above, generated at BUILD time and shipped beside it (#1137).
   *
   * `install.sh` compares it before installing. This is a checksum, NOT a signature: anyone who can
   * write both files in this container defeats it, and it is not meant to survive that — ADR-0074
   * defers cosign as an enterprise ask. What it does buy is real and costs nothing: a corrupted
   * layer, a half-written volume, a caching proxy serving a stale artifact, and a tamper that changed
   * the binary without also changing the digest all stop at the installer instead of becoming root
   * on every host in the estate.
   *
   * Gated on `infra:report` like the download, so publishing a digest opens no new surface. Answers
   * bare lowercase hex — `sha256sum`'s `<hex>  <name>` shape is accepted on the way in and trimmed,
   * so the build step may use either tool.
   */
  @Get('checksum')
  @RequirePermission('infra:report')
  @Header('content-type', 'text/plain; charset=utf-8')
  @ApiOperation({
    summary:
      'The sha256 of the agent binary for the given arch, as bare lowercase hex (ADR-0074, #1137). MACHINE-intended: gated on infra:report. Generated at build time beside the binary and verified by install.sh; an integrity check, not a signature. 404 if this build published none.',
  })
  @ApiQuery({ name: 'arch', enum: ARCHES })
  @ApiOkResponse({ description: 'The 64-character lowercase hex digest.' })
  checksum(@Query('arch') arch?: string): string {
    const path = join(
      AGENT_BIN_DIR,
      `lazyit-agent-${requireArch(arch)}.sha256`,
    );
    if (!existsSync(path)) {
      throw new NotFoundException(
        'no sha256 published for that arch in this build',
      );
    }
    // First whitespace-delimited field: `sha256sum` writes `<hex>  <name>`, `shasum -a 256` the same,
    // and the repo's own Bun generator writes the bare digest. All three land on the same answer.
    const digest = readFileSync(path, 'utf8').trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new NotFoundException(
        'no sha256 published for that arch in this build',
      );
    }
    return digest;
  }
}
