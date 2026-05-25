---
id: SEC-001
title: Article import buffers unbounded uploads into memory before the size check (DoS)
severity: medium
status: open
cwe: CWE-770
discovered: 2026-05-25
module: articles
tags: [dos, upload, resource-exhaustion]
---

# SEC-001 — Unbounded multipart upload buffered before the size check

## Summary

`POST /articles/import` lets a caller stream an arbitrarily large file into the Node heap: multer
buffers the whole upload in memory and only *afterwards* does the service reject it for exceeding
`MAX_IMPORT_SIZE_MB`.

## Description

The endpoint uses `FileInterceptor('file')` with no `limits` option
(`apps/api/src/articles/articles.controller.ts:148`). With the default memory storage, multer reads
the entire request body into a `Buffer` before the handler runs. The size guard lives in the service
and fires only after that buffer already exists:

```ts
if (file.size > maxImportBytes()) {        // articles.service.ts:185
  throw new BadRequestException(`File exceeds the ${maxImportMb()} MB import limit`);
}
```

So the limit rejects the *response*, not the *allocation*. Express's default ~100 kB JSON body limit
does not help — `multipart/form-data` is handled by multer, which has **no default `fileSize` cap**.
A few concurrent hundred-MB/GB uploads exhaust the heap and OOM-kill the process.

## Impact

Availability. A single caller — no auth required (the API is unauthenticated, ADR-0016) — can crash
the API with one or a few large POSTs. The dev-only posture limits *exposure*, but a legitimate user
can trigger this by accident too (a 2 GB file), so it is rated on its own merit, not as part of the
no-auth debt.

## Proof of concept

Reasoned from the code, **not executed** (the API is not run during review):

```sh
# 2 GB streamed as the upload; OOM before the 5 MB check ever runs.
head -c 2000000000 /dev/zero > big.bin
curl -s -X POST http://localhost:3001/articles/import \
  -H 'X-User-Id: <valid-user-uuid>' \
  -F 'categoryId=<cuid>' -F 'file=@big.bin;filename=big.md'
```

## Affected

- `apps/api/src/articles/articles.controller.ts:148` — `FileInterceptor('file')` with no `limits`.
- `apps/api/src/articles/articles.service.ts:185-189` — size check runs post-buffering.

## Recommendation

Enforce the cap at the interceptor so multer aborts the stream early:

```ts
@UseInterceptors(
  FileInterceptor('file', { limits: { fileSize: maxImportBytes() } }),
)
```

Multer then errors once the limit is passed (map it to 413, or let the existing flow surface a 400).
`maxImportBytes()` is evaluated at decoration time, so the limit is fixed at boot — acceptable, since
`MAX_IMPORT_SIZE_MB` is a boot-time env. Keep the service-level `file.size` check as defense in depth.
Note this does **not** cover SEC-002 (a limit-compliant `.docx` can still blow up on decompression).

## Prevention

Make "every file upload declares `limits.fileSize`" a review rule (grep for `FileInterceptor(` without
`limits`). If more upload endpoints appear, centralize via `MulterModule.register({ limits })`.

## References

- CWE-770: Allocation of Resources Without Limits or Throttling. CWE-400: Uncontrolled Resource Consumption.
- ADR-0021 (KB design — import) · ADR-0016 (no auth yet).
