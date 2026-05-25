---
id: SEC-002
title: .docx import is a decompression-bomb vector (compressed size is checked, not expanded)
severity: medium
status: open
cwe: CWE-409
discovered: 2026-05-25
module: articles
tags: [dos, upload, zip-bomb, mammoth]
---

# SEC-002 — .docx decompression bomb on import

## Summary

A small, limit-compliant `.docx` can decompress to gigabytes while `mammoth` parses it: the import
size guard checks the **compressed** upload, so a zip bomb passes the check and exhausts memory.

## Description

`.docx` is a ZIP container. The import path hands the raw buffer to mammoth:

```ts
({ value } = await mammothMd.convertToMarkdown({ buffer: file.buffer }));  // article-import.ts:77
```

mammoth unzips and parses the inner XML in memory. The only size control is
`file.size > maxImportBytes()` (`articles.service.ts:185`), which measures the **compressed** upload.
A highly compressible `word/document.xml` (megabytes of repeated whitespace/markup) yields a multi-MB
`.docx` that expands to hundreds of MB / GB at parse time. This is distinct from SEC-001: even with a
`limits.fileSize` cap on the upload, the *decompressed* size stays unbounded.

## Impact

Availability. An unauthenticated caller (ADR-0016) uploads a file that passes every size check and
still drives the process to OOM during parsing. Harder to notice than SEC-001 because the upload looks
innocuous (a few MB).

## Proof of concept

Reasoned, **not executed**. Build a `.docx` whose `word/document.xml` is a few MB of repeated content;
the zipped file stays under `MAX_IMPORT_SIZE_MB` (5) but `convertToMarkdown` allocates the
fully-expanded XML plus mammoth's document model. Upload it as a normal import.

## Affected

- `apps/api/src/articles/article-import.ts:74-84` — `mammothMd.convertToMarkdown({ buffer })`.
- `apps/api/src/articles/articles.service.ts:185-189` — size check is on the compressed bytes only.

## Recommendation

The compressed-size check cannot bound this. Options, cheapest first:

- Inspect the ZIP central directory and **reject by uncompressed size / compression ratio** before
  parsing (e.g. refuse if total uncompressed exceeds N× the limit, or ratio > ~100:1).
- Run docx parsing in a **worker with a memory/time budget** (fits the future BullMQ direction) so a
  bomb kills the worker, not the API.
- At minimum, document the residual risk and keep `.docx` import behind the eventual auth boundary.

## Prevention

Treat any archive/compressed format (docx today; pptx/xlsx/odt/zip later) as amplification-prone: bound
the *expanded* size, never trust the upload size. Capture this beside ADR-0021's deferred-formats list.

## References

- CWE-409: Improper Handling of Highly Compressed Data (Data Amplification). CWE-400.
- ADR-0021 (import formats; `.docx` via mammoth, "no external binaries") · SEC-001.
