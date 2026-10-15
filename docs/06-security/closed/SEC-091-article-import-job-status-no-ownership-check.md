---
id: SEC-091
title: GET /articles/import/:jobId returns any user's import job (no ownership or folder check, sequential job ids)
severity: medium
status: open
cwe: CWE-639
discovered: 2026-10-10
module: articles (import)
tags: [idor, info-leak, kb, inv-9, bullmq]
---

# SEC-091 — Article import job status is readable by any `article:write` holder

## Summary

`GET /articles/import/:jobId` loads the BullMQ job by id and returns its outcome to any caller holding
`article:write`, without comparing the caller with the job's author or checking folder access. BullMQ
job ids are sequential integers, so every recent import can be enumerated, including imports into
folders the caller cannot read.

## Description

- The route passes no principal (`apps/api/src/articles/articles.controller.ts:459-468`).
- `getStatus` (`apps/api/src/articles/import/article-import.service.ts:139-158`) returns the state, the
  created `articleId`, and for a `.zip` import the whole batch: every entry's archive `path`, final
  `slug`, `requestedSlug`, `articleId` and skip reason (`packages/shared/src/schemas/article-import-job.ts:41-65`).
  On failure it returns the friendly error text. It never reads `job.data.authorId`, which the enqueue
  stores (`article-import.service.ts:99`).
- The job is added without a `jobId` (`article-import.service.ts:108-115`), so BullMQ assigns the next
  value of the queue's integer counter. Completed jobs stay pollable for an hour and failed jobs for 24
  hours, up to 1000 of each.
- The asset import sessions do this correctly: every read and write is scoped by `ownerId`
  (`apps/api/src/import/import-session.service.ts:209-216`).

## Impact

A MEMBER (the default holder of `article:write`) learns other users' import file names and archive
layouts, and the slugs and ids of the articles they created, drafts included. For an import
into a restricted folder this reveals that hidden articles exist and what they are called, which INV-9
forbids: a folder-hidden article must not reveal its existence. Article bodies are not exposed; the ids
still 404 on `/articles/:id`. Rated **Medium** (the verifiers split Medium/Low): a read-only metadata
leak bounded to a one-hour window, but cross-user and against the KB's access boundary.

## Proof of concept

Reasoned from code, **not executed** (the API is not run during review).

```sh
# A MEMBER walks the counter; each recent job returns its batch report.
for id in $(seq 1 200); do
  curl -s -H "Authorization: Bearer $MEMBER" https://lazyit.example/api/articles/import/$id
done
# → {"jobId":"57","state":"completed","articleId":null,
#    "batch":{"items":[{"path":"HR/Salaries/2026-bands.md","outcome":"created","slug":"2026-bands",...}]}}
```

## Affected

Verified on `dev` at `a4ca679ea`.

- `apps/api/src/articles/articles.controller.ts:459-468` — `importStatus`, no principal.
- `apps/api/src/articles/import/article-import.service.ts:139-158` — `getStatus`, no ownership check.
- `apps/api/src/articles/import/article-import.service.ts:108-115` — `queue.add` with no `jobId`.

## Recommendation

Pass the principal to `getStatus` and return the same 404 as an unknown id unless
`job.data.authorId` is the caller (an ADMIN may be allowed to read any job). Optionally enqueue with
an unguessable `jobId` (a random UUID) so the id is no longer enumerable. No data change: jobs are
transient queue entries, and a job enqueued before the fix still carries `authorId`.

## Prevention

Any route that reads a queued job, upload or session by id resolves it scoped to its owner, as the
asset import sessions do. A controller test that a second user's poll of a job id is a 404.

## References

- CWE-639 Authorization Bypass Through User-Controlled Key; OWASP A01:2021 Broken Access Control.
- [[0059-kb-folders-links-and-import]] §5 · [[0053-async-workers-bullmq-valkey]] ·
  [[0060-kb-folder-access-control]] · [[INVARIANTS]] INV-9.
- Sweep: [[sweep-2026-10-10-backend-audit]] (AUD-004).
