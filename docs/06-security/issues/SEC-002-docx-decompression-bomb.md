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

## Triage note

🚨 Escalated to user on 2026-05-25 — no clean, dep-free, bounded fix exists; the robust fix is
structural. Bounding the *decompressed* size of a `.docx` reliably needs either a memory-budgeted
worker or a streaming inflate cap. The compressed-size check (and SEC-001's interceptor cap) can't
bound expansion, and the ZIP central directory's declared uncompressed sizes can't be trusted (the
inflater reads the deflate stream to its end regardless).

Options:

1. **`worker_threads` Worker with `resourceLimits.maxOldGenerationSizeMb`** — parse the docx in a
   worker; a bomb crashes the worker (not the API) → map to 413/400. Dep-free, robust, moderate
   complexity (worker lifecycle + buffer transfer + the deprecated `convertToMarkdown` inside it).
2. **Defer to the planned BullMQ/Redis async worker** (ADR-0009 tension) — move docx parsing off the
   request path entirely; document the residual until then. SEC-001's cap already bounds the
   *compressed* input (~5 MB), so worst-case expansion is bounded-but-large in the interim.
3. **Streaming `node:zlib` inflate of `word/document.xml` with a hard output-byte cap** before
   mammoth — dep-free but requires hand-rolling ZIP header/central-directory parsing (zip64, data
   descriptors), itself error-prone for a security control. **Not recommended.**

Recommendation: (1) if `.docx` import must stay synchronous and robust now; otherwise (2) and
document the residual. Either is an architectural choice → your call.
