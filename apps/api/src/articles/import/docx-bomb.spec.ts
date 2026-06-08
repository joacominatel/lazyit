import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

/**
 * SEC-002 regression (ADR-0053). A `.docx` is a ZIP; a decompression bomb is a small, limit-compliant
 * file whose entries expand to gigabytes when parsed. The async import runs that parse in a BullMQ
 * SANDBOXED processor — a forked Node child launched with `--max-old-space-size` — so the bomb OOMs
 * the isolated child (the job fails) while the API process stays alive.
 *
 * This test exercises that exact isolation primitive WITHOUT Redis/DB: it forks the same dangerous
 * step (mammoth `.docx` → markdown, the body of parseImportFile) in a heap-capped child, via
 * test/docx-import-child.cjs. A bomb must crash the child; a normal `.docx` must succeed in the same
 * capped child; and the test process (standing in for the API) must survive both.
 */

// The heap cap for the forked child. Small on purpose so a moderately sized bomb is enough to OOM it,
// keeping the fixture small/fast. The runtime worker uses a production-appropriate cap
// (IMPORT_CHILD_HEAP_MB, default 256) — a real bomb expands far past any sane value.
const CHILD_HEAP_MB = 64;

// Uncompressed size of the bomb's main document part. mammoth streams the XML through a SAX parser
// and builds an in-memory document model, so the bomb is VALID WordML packed with millions of empty
// paragraphs: ~128 MB of `<w:p/>` explodes mammoth's model to several hundred MB (measured ~480 MB) —
// far past the 64 MB cap — while compressing to well under a MB on disk.
const BOMB_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
// One empty paragraph: minimal bytes, one object in mammoth's model — maximizes heap blow-up per byte.
const BOMB_PARAGRAPH = '<w:p/>';

const RUNNER = join(__dirname, '../../../test/docx-import-child.cjs');
const API_DIR = join(__dirname, '../../..');
const SAMPLE_DOCX = join(__dirname, '../../../test/fixtures/sample.docx');

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Fork the runner against `filePath` with the heap cap and collect its outcome. */
function runChild(filePath: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${CHILD_HEAP_MB}`, RUNNER, filePath],
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

/** Build a structurally valid .docx whose word/document.xml decompresses to a huge buffer (a bomb). */
async function buildBombDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  // The bomb: a VALID WordML body packed with millions of empty paragraphs. mammoth parses it into
  // an in-memory model that dwarfs the heap cap. Highly repetitive, so it compresses to < 1 MB.
  const head =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`;
  const tail = `</w:body></w:document>`;
  const repeats = Math.ceil(BOMB_UNCOMPRESSED_BYTES / BOMB_PARAGRAPH.length);
  const document = head + BOMB_PARAGRAPH.repeat(repeats) + tail;
  zip.file('word/document.xml', Buffer.from(document));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });
}

describe('SEC-002 — a .docx decompression bomb crashes the sandboxed child, not the API', () => {
  let tmp: string;
  let bombPath: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lazyit-docx-bomb-'));
    bombPath = join(tmp, 'bomb.docx');
    writeFileSync(bombPath, await buildBombDocx());
  }, 120000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('builds a limit-compliant bomb (small on disk despite a huge expansion)', () => {
    const onDisk = readFileSync(bombPath).length;
    // A few hundred KB at most — it would sail through the MAX_IMPORT_SIZE_MB cap (SEC-001).
    expect(onDisk).toBeLessThan(5 * 1024 * 1024);
  });

  it('OOM-kills the heap-capped child on the bomb — and the parent (the API) survives', async () => {
    const result = await runChild(bombPath);

    // The child did NOT parse the bomb successfully...
    expect(result.stdout).not.toContain('OK');
    // ...and it did NOT exit via the graceful parse-error path (exit 3): it was hard-killed by the
    // V8 OOM abort — a non-zero exit code or a terminating signal. THIS is the isolation guarantee.
    const crashed =
      result.signal !== null || (result.code !== 0 && result.code !== 3);
    expect(crashed).toBe(true);

    // The parent process is still here, running assertions — the bomb never reached the API.
    expect(typeof process.pid).toBe('number');
  }, 120000);

  it('parses a normal .docx successfully in the SAME heap-capped child', async () => {
    const result = await runChild(SAMPLE_DOCX);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OK:');
  }, 60000);
});
