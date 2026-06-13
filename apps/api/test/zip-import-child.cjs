'use strict';

/**
 * Standalone child runner for the SEC-002 / ADR-0059 §5 isolation test. It mirrors the DANGEROUS step
 * the real sandboxed worker performs for a `.zip` — decompress every text entry into the heap (the
 * body of zip-extract's `extractZipEntries`) — and nothing else. The test forks this file with
 * `--max-old-space-size=<small>`, exactly like the BullMQ sandboxed processor is forked with the
 * import heap cap:
 *
 *   - a normal .zip            → prints "OK:<bytes>" and exits 0
 *   - an over-quota archive    → prints "QUOTA" and exits 3 (a controlled rejection, NOT an OOM)
 *   - a decompression bomb     → expands past the heap cap and the V8 runtime aborts THIS child with
 *     a fatal OOM (non-zero exit / signal, neither 0 nor 3). The parent process is never affected.
 *
 * This is NOT used at runtime; the real worker is src/articles/import/article-import.processor.ts.
 * The quota numbers below mirror zip-extract.ts (MAX_ZIP_ENTRIES / MAX_UNCOMPRESSED_BYTES) but are
 * passed in so the test can shrink them for a small, fast bomb fixture.
 */

const fs = require('node:fs');
const JSZip = require('jszip');

const filePath = process.argv[2];
const maxEntries = Number(process.argv[3] || '500');
const maxUncompressed = Number(process.argv[4] || String(50 * 1024 * 1024));

async function run() {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);

  // QUOTA #1 — entry count, on the central directory (no decompression).
  if (entries.length > maxEntries) {
    process.stdout.write('QUOTA');
    process.exit(3);
  }

  let total = 0;
  let textBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const name = entry.name.toLowerCase();
    if (!name.endsWith('.md') && !name.endsWith('.txt')) continue;
    // QUOTA #2 — declared uncompressed size, BEFORE decompressing this entry.
    const declared = (entry._data && entry._data.uncompressedSize) || 0;
    if (total + declared > maxUncompressed) {
      process.stdout.write('QUOTA');
      process.exit(3);
    }
    // DANGEROUS: decompress + decode into the heap. A bomb that lies about its declared size
    // expands here and OOMs the heap-capped child.
    const content = await entry.async('string');
    total += Math.max(declared, Buffer.byteLength(content, 'utf-8'));
    textBytes += content.length;
    if (total > maxUncompressed) {
      process.stdout.write('QUOTA');
      process.exit(3);
    }
  }
  process.stdout.write('OK:' + textBytes);
  process.exit(0);
}

run().catch(() => {
  // A controlled parse failure (NOT an OOM) — the child handled it and shut down cleanly.
  process.stdout.write('ERR');
  process.exit(4);
});
