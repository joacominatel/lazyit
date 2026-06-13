import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

/**
 * SEC-002 / ADR-0059 §5 regression. A `.zip` is a ZIP container — the SAME threat class as the `.docx`
 * the import worker already defends: a decompression bomb is a small, limit-compliant archive whose
 * text entries expand to gigabytes when decoded into the heap. The bulk `.zip` import runs that
 * expansion in the SAME BullMQ SANDBOXED processor (a forked Node child launched with
 * `--max-old-space-size`), now behind an entry-count + total-uncompressed-size QUOTA in front of the
 * heap cap.
 *
 * This test exercises BOTH arms of the guard WITHOUT Redis/DB, forking the same dangerous step
 * (decompress every text entry — the body of extractZipEntries) in a heap-capped child via
 * test/zip-import-child.cjs:
 *   - the QUOTA arm rejects an over-many / over-large archive cleanly (exit 3), no OOM;
 *   - the HEAP-CAP arm OOM-kills the child on a bomb that lies about its declared size;
 *   - a normal `.zip` succeeds in the same capped child;
 * and the test process (standing in for the API) survives all three.
 */

// Small heap cap so a moderately sized bomb is enough to OOM, keeping the fixture small/fast. The
// runtime worker uses IMPORT_CHILD_HEAP_MB (default 256) — a real bomb expands past any sane value.
const CHILD_HEAP_MB = 64;

// Uncompressed size of the bomb's single .md entry. ~256 MB of a repeated character decodes to a
// 256 MB JS string in the child — far past the 64 MB cap — while compressing to well under a MB.
const BOMB_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

// A tiny per-child quota for the QUOTA-arm test: assert a controlled rejection, not an OOM.
const SMALL_MAX_ENTRIES = 5;
const SMALL_MAX_BYTES = 1 * 1024 * 1024;

const RUNNER = join(__dirname, '../../../test/zip-import-child.cjs');
const API_DIR = join(__dirname, '../../..');

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Fork the runner against `filePath` with the heap cap + quota args and collect its outcome. */
function runChild(
  filePath: string,
  maxEntries: number,
  maxBytes: number,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MB}`,
        RUNNER,
        filePath,
        String(maxEntries),
        String(maxBytes),
      ],
      { cwd: API_DIR, env: process.env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

/** A `.zip` with one .md entry that decompresses to a huge in-memory string (a bomb). */
async function buildBombZip(): Promise<Buffer> {
  const zip = new JSZip();
  // A single highly-repetitive entry: compresses to < 1 MB, decodes to ~256 MB.
  zip.file('bomb.md', 'A'.repeat(BOMB_UNCOMPRESSED_BYTES));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });
}

/** A normal small `.zip` with a couple of text entries. */
async function buildNormalZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('guide.md', '# Guide\n\nA short runbook.');
  zip.file('notes/setup.txt', 'plain setup notes');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A `.zip` with more entries than the small per-child entry-count quota. */
async function buildManyEntryZip(): Promise<Buffer> {
  const zip = new JSZip();
  for (let i = 0; i < SMALL_MAX_ENTRIES + 5; i++) {
    zip.file(`note-${i}.md`, `# Note ${i}`);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('SEC-002 / ADR-0059 §5 — a .zip bomb crashes the sandboxed child, not the API', () => {
  let tmp: string;
  let bombPath: string;
  let normalPath: string;
  let manyPath: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lazyit-zip-bomb-'));
    bombPath = join(tmp, 'bomb.zip');
    normalPath = join(tmp, 'normal.zip');
    manyPath = join(tmp, 'many.zip');
    writeFileSync(bombPath, await buildBombZip());
    writeFileSync(normalPath, await buildNormalZip());
    writeFileSync(manyPath, await buildManyEntryZip());
  }, 120000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('builds a limit-compliant bomb (small on disk despite a huge expansion)', () => {
    const onDisk = readFileSync(bombPath).length;
    // A few hundred KB at most — it would sail through the MAX_IMPORT_SIZE_MB cap (SEC-001).
    expect(onDisk).toBeLessThan(5 * 1024 * 1024);
  });

  it('rejects an over-entry-count archive via the QUOTA arm (exit 3), NOT an OOM', async () => {
    const result = await runChild(manyPath, SMALL_MAX_ENTRIES, SMALL_MAX_BYTES);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('QUOTA');
  }, 60000);

  it('OOM-kills the heap-capped child on a size-lying bomb — and the parent (the API) survives', async () => {
    // Give a generous byte quota so the DECLARED-size check passes and the child actually decompresses
    // the bomb into the heap — proving the heap cap (not just the quota) contains a real expansion.
    const result = await runChild(
      bombPath,
      100,
      BOMB_UNCOMPRESSED_BYTES * 2,
    );

    // The child did NOT succeed and did NOT take the controlled quota/err exits (3/4): it was
    // hard-killed by the V8 OOM abort — a non-zero exit code or a terminating signal. THE guarantee.
    expect(result.stdout).not.toContain('OK');
    const crashed =
      result.signal !== null ||
      (result.code !== 0 && result.code !== 3 && result.code !== 4);
    expect(crashed).toBe(true);

    // The parent process is still here, running assertions — the bomb never reached the API.
    expect(typeof process.pid).toBe('number');
  }, 120000);

  it('extracts a normal .zip successfully in the SAME heap-capped child', async () => {
    const result = await runChild(
      normalPath,
      500,
      50 * 1024 * 1024,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OK:');
  }, 60000);
});
