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
    download(arch?: string): {
      getStream(): {
        on(event: string, cb: () => void): unknown;
        destroy(): void;
      };
    };
    checksum(arch?: string): string;
  };
};

const controller = new AgentDistController();

afterAll(() => rmSync(BIN_DIR, { recursive: true, force: true }));

describe('AgentDistController — arches (#1137)', () => {
  it('serves the pre-AVX2 baseline x86-64 build, so a pre-Haswell or EVC-masked host has an artifact', () => {
    writeFileSync(join(BIN_DIR, 'lazyit-agent-x64-baseline'), 'ELF');
    const stream = controller.download('x64-baseline').getStream();
    // Closed straight away, with an error sink: the read stream opens lazily and nothing here
    // consumes it, so an unattended handle emits ENOENT once the scratch directory is removed —
    // which node turns into an unhandled 'error' event and a dead test process.
    stream.on('error', () => {});
    stream.destroy();
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
    writeFileSync(join(BIN_DIR, 'lazyit-agent-arm64.sha256'), `${digest}\n`);
    expect(controller.checksum('arm64')).toBe(digest);
  });

  it('tolerates the `<hex>  <filename>` shape `sha256sum` writes, taking only the digest', () => {
    const digest = 'b'.repeat(64);
    writeFileSync(
      join(BIN_DIR, 'lazyit-agent-x64.sha256'),
      `${digest}  lazyit-agent-x64\n`,
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
