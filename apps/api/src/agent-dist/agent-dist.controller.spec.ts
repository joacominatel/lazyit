import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';

/**
 * `AGENT_BIN_DIR` is read at MODULE LOAD, so the scratch directory has to exist and be in the
 * environment before the controller module is imported — hence the require() below rather than a
 * top-level import.
 */
const BIN_DIR = mkdtempSync(join(tmpdir(), 'lazyit-agent-bin-'));
process.env.AGENT_BIN_DIR = BIN_DIR;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentDistController } = require('./agent-dist.controller') as {
  AgentDistController: new () => {
    download(
      arch?: string,
      os?: string,
    ): {
      options: { disposition?: string };
      getStream(): {
        on(event: string, cb: () => void): unknown;
        destroy(): void;
      };
    };
    checksum(arch?: string, os?: string): string;
  };
};

const controller = new AgentDistController();

/** Open + immediately close the lazy read stream, so no handle outlives the scratch directory. */
function drain(file: {
  getStream(): { on(e: string, cb: () => void): unknown; destroy(): void };
}) {
  const stream = file.getStream();
  stream.on('error', () => {});
  stream.destroy();
}

afterAll(() => rmSync(BIN_DIR, { recursive: true, force: true }));

describe('AgentDistController — arches (#1137)', () => {
  it('serves the pre-AVX2 baseline x86-64 build, so a pre-Haswell or EVC-masked host has an artifact', () => {
    writeFileSync(join(BIN_DIR, 'lazyit-agent-linux-x64-baseline'), 'ELF');
    // Closed straight away, with an error sink: the read stream opens lazily and nothing here
    // consumes it, so an unattended handle emits ENOENT once the scratch directory is removed —
    // which node turns into an unhandled 'error' event and a dead test process.
    drain(controller.download('x64-baseline'));
  });

  it('still rejects an unknown arch, and names the ones it has', () => {
    expect(() => controller.download('x64-modern')).toThrow(NotFoundException);
    try {
      controller.download('x64-modern');
    } catch (err) {
      expect((err as Error).message).toContain('x64-baseline');
    }
  });

  // The arch is matched against a closed list before it ever reaches join(), which is what keeps a
  // crafted value from walking out of AGENT_BIN_DIR. Pinned rather than assumed: this route reads a
  // file path from a query string.
  it('a traversal attempt is an unknown arch, not a path', () => {
    expect(() => controller.download('../../etc/passwd')).toThrow(
      NotFoundException,
    );
    expect(() => controller.checksum('../../etc/passwd')).toThrow(
      NotFoundException,
    );
  });
});

describe('AgentDistController.checksum — the digest install.sh verifies (#1137)', () => {
  it('returns the published digest as bare lowercase hex, which is what the installer compares', () => {
    const digest = 'a'.repeat(64);
    writeFileSync(
      join(BIN_DIR, 'lazyit-agent-linux-arm64.sha256'),
      `${digest}\n`,
    );
    expect(controller.checksum('arm64')).toBe(digest);
  });

  it('tolerates the `<hex>  <filename>` shape `sha256sum` writes, taking only the digest', () => {
    const digest = 'b'.repeat(64);
    writeFileSync(
      join(BIN_DIR, 'lazyit-agent-linux-x64.sha256'),
      `${digest}  lazyit-agent-linux-x64\n`,
    );
    expect(controller.checksum('x64')).toBe(digest);
  });

  // A build that did not generate the digest must 404 rather than serve something the installer
  // would compare against — install.sh reads a non-64-hex answer as "no digest published" either
  // way, but 404 is the honest status and it is what --require-checksum keys on.
  it('404s when this build published no digest for that arch', () => {
    expect(() => controller.checksum('x64-baseline')).toThrow(
      NotFoundException,
    );
  });
});

/**
 * Issue #1144. The route keyed the filename on ARCH ALONE, so the moment a second OS shipped,
 * `lazyit-agent-x64` meant two different binaries and the Windows build would have overwritten the
 * Linux one in the same directory. The artifact is now `lazyit-agent-<os>-<arch>[.exe]` and the route
 * takes an `os` parameter.
 *
 * The compatibility half is the part that matters on the upgrade path: every `install.sh` already
 * deployed on a live estate asks for `?arch=x64` with no `os`, and those installers live on the
 * hosts, not in the image — upgrading the instance does not upgrade them. An omitted `os` therefore
 * still means Linux, and it resolves to the renamed artifact.
 */
describe('AgentDistController — the os parameter and the legacy arch-only path (#1144)', () => {
  it('serves the Windows executable when os=windows is asked for', () => {
    writeFileSync(join(BIN_DIR, 'lazyit-agent-windows-x64.exe'), 'MZ');
    const file = controller.download('x64', 'windows');
    drain(file);
    // The `.exe` suffix rides the Content-Disposition too: install.ps1 saves what it is handed, and
    // a Windows host will not execute a file without it.
    expect(file.options.disposition).toContain('lazyit-agent-windows-x64.exe');
  });

  it('an arch-only request (an install.sh already in the field) still resolves to the Linux build', () => {
    // Nothing named `lazyit-agent-x64` exists in this directory. The legacy path must find the
    // RENAMED binary, not 404, or every deployed installer breaks on the next instance upgrade.
    writeFileSync(join(BIN_DIR, 'lazyit-agent-linux-x64'), 'ELF');
    const file = controller.download('x64');
    drain(file);
    expect(file.options.disposition).toContain('lazyit-agent-linux-x64');
  });

  it('the legacy checksum path resolves the same way', () => {
    expect(controller.checksum('x64')).toBe('b'.repeat(64));
  });

  it('a legacy request never reaches a Windows artifact, whatever the arch', () => {
    // `?arch=x64` from an old install.sh on a Linux host must not be answered with a PE executable
    // just because one happens to be bundled under a name that shares the arch.
    expect(() => controller.download('arm64')).toThrow(NotFoundException);
  });

  it('rejects an unknown os, and names the ones it has', () => {
    expect(() => controller.download('x64', 'darwin')).toThrow(
      NotFoundException,
    );
    try {
      controller.download('x64', 'darwin');
    } catch (err) {
      expect((err as Error).message).toContain('windows');
    }
  });

  it('rejects an arch this OS has no build for, rather than 404-ing on a missing file', () => {
    // There is no Bun windows-arm64 target. Saying so is a better answer than "not bundled in this
    // build", which reads as "upgrade your instance" for something no upgrade will ever provide.
    expect(() => controller.download('arm64', 'windows')).toThrow(
      NotFoundException,
    );
    try {
      controller.download('arm64', 'windows');
    } catch (err) {
      expect((err as Error).message).toContain('windows');
    }
  });

  it('an os traversal attempt is an unknown os, not a path', () => {
    expect(() => controller.download('x64', '../../etc')).toThrow(
      NotFoundException,
    );
    expect(() => controller.checksum('x64', '../../etc')).toThrow(
      NotFoundException,
    );
  });
});
