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
 * compiles `lazyit-agent-<os>-<arch>[.exe]` and their `.sha256` files into here. Overridable via env
 * for dev/test; absent in a non-Docker dev build → the routes 404 with a clear message.
 */
const AGENT_BIN_DIR = process.env.AGENT_BIN_DIR ?? '/app/agent/bin';

/**
 * The operating systems this instance ships an agent for (#1144).
 *
 * `linux` is also what an OMITTED `os` means, and that is a compatibility guarantee rather than a
 * default worth revisiting: every `install.sh` already running on a live estate asks for
 * `?arch=x64` with no `os`, those copies live on the HOSTS rather than in this image, and upgrading
 * the instance does not upgrade them.
 */
const OSES = ['linux', 'windows'] as const;
type AgentOs = (typeof OSES)[number];

/**
 * The arches built per OS. Not one flat list, because the sets genuinely differ: Bun has no
 * `bun-windows-arm64` target, so asking for one is a question no instance upgrade will ever answer
 * and the route says so instead of 404-ing with "not bundled in this build".
 *
 * `x64-baseline` is the pre-AVX2 x86-64 build (#1137). Bun's ordinary x64 targets assume AVX2
 * (Haswell, 2013), so a pre-Haswell host — or a vSphere/Hyper-V cluster whose EVC baseline masks the
 * flag — dies with SIGILL, in the worst case months later when a live migration lands the VM on
 * older silicon. `install.sh` reads `/proc/cpuinfo` and asks for it automatically; `install.ps1` has
 * no equivalent CPU-flag source on Windows and takes `-Baseline` instead.
 */
const ARCHES_BY_OS: Record<AgentOs, readonly string[]> = {
  linux: ['x64', 'x64-baseline', 'arm64'],
  windows: ['x64', 'x64-baseline'],
};

/** Every arch any OS builds — the enum published to OpenAPI, where the param is not per-OS. */
const ALL_ARCHES = ['x64', 'x64-baseline', 'arm64'] as const;

/** One resolved download target: which OS, which arch, and whether the caller named the OS at all. */
interface Target {
  os: AgentOs;
  arch: string;
  /** True when `os` was omitted — an installer that predates #1144. See {@link candidates}. */
  legacy: boolean;
}

/**
 * The target, validated against the closed lists — the only thing that ever reaches `join()`.
 *
 * Both parameters are matched against enumerated values before any path is built, which is what
 * keeps a crafted `os` or `arch` from walking out of `AGENT_BIN_DIR`.
 */
function requireTarget(arch?: string, os?: string): Target {
  const legacy = os === undefined || os === '';
  const resolvedOs = legacy ? 'linux' : (os as AgentOs);
  if (!OSES.includes(resolvedOs)) {
    throw new NotFoundException(
      `unknown os "${os ?? ''}" — expected one of: ${OSES.join(', ')}`,
    );
  }
  const arches = ARCHES_BY_OS[resolvedOs];
  if (!arch || !arches.includes(arch)) {
    throw new NotFoundException(
      `unknown arch "${arch ?? ''}" for os "${resolvedOs}" — expected one of: ${arches.join(', ')}`,
    );
  }
  return { os: resolvedOs, arch, legacy };
}

/** `.exe`, because a Windows host will not execute a file without it — and nothing else needs one. */
function extensionFor(os: AgentOs): string {
  return os === 'windows' ? '.exe' : '';
}

/**
 * The filenames to try, in order, for one target.
 *
 * The first is the artifact this build produces: `lazyit-agent-<os>-<arch>[.exe]`. The second exists
 * only for a LEGACY (`os`-less) request and only names the pre-#1144 layout — it is a fallback for an
 * externally mounted `AGENT_BIN_DIR` that still holds the old filenames, never a way for a Windows
 * artifact to answer an arch-only request. A legacy request resolves to Linux and to nothing else.
 */
function candidates({ os, arch, legacy }: Target, suffix = ''): string[] {
  const names = [`lazyit-agent-${os}-${arch}${extensionFor(os)}${suffix}`];
  if (legacy) names.push(`lazyit-agent-${arch}${suffix}`);
  return names;
}

/** The first candidate that exists, or `undefined` when this build bundles none of them. */
function resolveFile(
  target: Target,
  suffix = '',
): { name: string; path: string } | undefined {
  for (const name of candidates(target, suffix)) {
    const path = join(AGENT_BIN_DIR, name);
    if (existsSync(path)) return { name, path };
  }
  return undefined;
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
      'Download the lazyit reporting agent binary for the given os + arch (ADR-0074). MACHINE-intended: gated on infra:report (the agent SA token). Streams the baked Bun-compiled executable; 404 if not bundled in this build. `os` defaults to `linux` so installers that predate #1144 keep working. `x64-baseline` is the pre-AVX2 build for older or EVC-masked x86-64 hosts; there is no windows/arm64 build.',
  })
  @ApiQuery({ name: 'os', enum: OSES, required: false })
  @ApiQuery({ name: 'arch', enum: ALL_ARCHES })
  @ApiOkResponse({
    description: 'The agent binary (application/octet-stream).',
  })
  download(
    @Query('arch') arch?: string,
    @Query('os') os?: string,
  ): StreamableFile {
    const found = resolveFile(requireTarget(arch, os));
    if (!found) {
      throw new NotFoundException('agent binary not bundled in this build');
    }
    return new StreamableFile(createReadStream(found.path), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${found.name}"`,
    });
  }

  /**
   * The sha256 of the binary above, generated at BUILD time and shipped beside it (#1137).
   *
   * `install.sh` and `install.ps1` compare it before installing. This is a checksum, NOT a signature:
   * anyone who can write both files in this container defeats it, and it is not meant to survive that
   * — ADR-0074 defers cosign as an enterprise ask. What it does buy is real and costs nothing: a
   * corrupted layer, a half-written volume, a caching proxy serving a stale artifact, and a tamper
   * that changed the binary without also changing the digest all stop at the installer instead of
   * becoming root (or SYSTEM) on every host in the estate.
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
      'The sha256 of the agent binary for the given os + arch, as bare lowercase hex (ADR-0074, #1137). MACHINE-intended: gated on infra:report. Generated at build time beside the binary and verified by install.sh / install.ps1; an integrity check, not a signature. `os` defaults to `linux`. 404 if this build published none.',
  })
  @ApiQuery({ name: 'os', enum: OSES, required: false })
  @ApiQuery({ name: 'arch', enum: ALL_ARCHES })
  @ApiOkResponse({ description: 'The 64-character lowercase hex digest.' })
  checksum(@Query('arch') arch?: string, @Query('os') os?: string): string {
    const found = resolveFile(requireTarget(arch, os), '.sha256');
    if (!found) {
      throw new NotFoundException(
        'no sha256 published for that os/arch in this build',
      );
    }
    // First whitespace-delimited field: `sha256sum` writes `<hex>  <name>`, `shasum -a 256` the same,
    // and the repo's own Bun generator writes the bare digest. All three land on the same answer.
    const digest =
      readFileSync(found.path, 'utf8').trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new NotFoundException(
        'no sha256 published for that os/arch in this build',
      );
    }
    return digest;
  }
}
