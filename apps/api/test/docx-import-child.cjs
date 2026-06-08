'use strict';

/**
 * Standalone child runner for the SEC-002 isolation test (ADR-0053). It mirrors the DANGEROUS step
 * the real sandboxed worker performs — parseImportFile's `.docx` branch is `mammoth.convertToMarkdown`
 * — and nothing else. The test forks this file with `--max-old-space-size=<small>`, exactly like the
 * BullMQ sandboxed processor is forked with the import heap cap:
 *
 *   - a normal .docx     → prints "OK:<len>" and exits 0
 *   - a graceful parse error → prints "ERR" and exits 3
 *   - a decompression bomb → expands past the heap cap and the V8 runtime aborts THIS child with a
 *     fatal OOM (non-zero exit / signal, neither 0 nor 3). The parent process is never affected.
 *
 * This is NOT used at runtime; the real worker is src/articles/import/article-import.processor.ts.
 */

const fs = require('node:fs');
const mammoth = require('mammoth');

const filePath = process.argv[2];
const buffer = fs.readFileSync(filePath);

mammoth
  .convertToMarkdown({ buffer })
  .then((res) => {
    process.stdout.write('OK:' + (res && res.value ? res.value.length : 0));
    process.exit(0);
  })
  .catch(() => {
    // A controlled parse failure (NOT an OOM) — the child handled it and shut down cleanly.
    process.stdout.write('ERR');
    process.exit(3);
  });
