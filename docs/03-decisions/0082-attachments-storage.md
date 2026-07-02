---
title: "ADR-0082: File attachments — filesystem volume, API-only serving, deferred backup"
tags: [adr, attachments, storage, kb, assets, security, backups]
status: accepted
created: 2026-07-01
updated: 2026-07-01
deciders: [Joaquín Minatel]
---

# ADR-0082: File attachments — filesystem volume, API-only serving, deferred backup

## Status

accepted — issue #876. First binary-upload subsystem in lazyit. Serves two surfaces from one
model: **documents on assets** (warranty PDFs, receipts, damage photos) and **inline images in KB
runbooks** (`![](attachment:<id>)`). Blobs live on a named Docker volume mounted on the api
service. Serving is API-only, behind per-parent authz. Backup coverage is **deferred to v1.1 by
explicit CEO decision** — a documented, loud gap (see [Deferred](#deferred)). Lands the long-deferred
KB render-time sanitizer with the first image render ([[0029-untrusted-content-sanitization]] /
SEC-003).

## Context

Today lazyit stores no user-uploaded files. Two real pains, surfaced by the discovery panel:

- **KB authors cannot inline images.** Marta (the main runbook author) pastes screenshots straight
  into Notion/Confluence and will keep her runbooks there unless lazyit matches that flow. The
  Markdown editor has nowhere to put an image, and the KB **importer silently discards** images —
  so migrated Google-Docs/wiki runbooks arrive with broken placeholders.
- **Asset documentation is scattered.** Dave (sole sysadmin) keeps warranty PDFs and receipts in a
  Drive folder nobody can find and damage photos in a WhatsApp thread — none of it linked to the
  asset record.

Marta and Dave both flagged the **same trap**: an attachments store that is not backed up the way
the DB is. Dave has been burned by exactly this (a laptop died with the only copy of a screenshot
folder). The [[backups]] runbook already opens with a danger callout — "the #1 DR mistake is backing
up only part of the system." Any storage choice must be honest about where it lands in that story.

### Constraints (verified against the repo)

- **INV-10 / SEC-003 — served active content is the one serious threat.** Every uploader is an
  authenticated employee, so a malicious-uploader model is largely moot. The load-bearing risk is a
  blob served back **on the app origin** that executes script in a victim's browser (SVG/HTML XSS,
  content-type spoofing, polyglots). Because the Secret Manager decrypts vaults **client-side**
  ([[0061-secret-manager-zero-knowledge]] INV-10), same-origin XSS is the highest-impact bug class
  in the whole app. This subsystem must not open that door.
- **The web proxy makes any media-extension path PUBLIC.** `apps/web/proxy.ts` `isPublicPath` (the
  regex at **line 44**) returns `true` for any pathname ending in
  `mp4|webm|ogg|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|mp3` — it bypasses the login gate to
  serve `/public` static assets. **Consequence:** an attachment URL routed through web with a media
  extension would be silently *unauthenticated*. Attachments must be served from the **API origin**.
- **Uploads must never buffer whole files in memory.** [[0053-async-workers-bullmq-valkey]] pins the
  OOM discipline on the 768m API; the KB importer already streams and caps. No `memoryStorage`.
- **Sanitizer discipline.** [[0029-untrusted-content-sanitization]] stores content verbatim and
  sanitizes at *render* time, and explicitly forbids shipping a new renderer without the allow-list
  sanitizer in the same change. KB inline images are the first authored content rendered as HTML —
  so the render-time sanitizer must land **with** this ADR.
- **No mandatory cloud** ([[0028-secrets-and-config]]). No new required service or credential.

## Decision

### 1. One polymorphic `Attachment` model

A single model serves both surfaces (house style: a soft handle-ref, not a hard FK on the parent):

```
model Attachment {
  id           String   @id @default(cuid())
  entityType   AttachmentEntityType   // ASSET | ARTICLE
  entityId     String                 // soft ref — NO FK; parent validated live at attach time
  sha256       String                 // content hash → the on-disk blob key (dedup)
  byteSize     Int
  mimeType     String                 // server-DERIVED, allowlisted (never the client value)
  originalName String                 // metadata only, never a filesystem path
  uploadedById String                 // human uuid
  createdAt    DateTime @default(now())
  deletedAt    DateTime?              // soft delete ([[0006-soft-delete-and-auditing]])
  @@index([entityType, entityId])
  @@index([sha256])
  @@map("attachments")
}
```

- **No FK on `entityId`** — mirrors the KB chip / `SecretAuditLog` / `InfraNodeSecretRef` soft-ref
  house style. The parent (`asset:read`-able asset, or a visible article) is validated **live at
  attach time**; a dangling ref degrades gracefully, it never crashes.
- The row holds only **metadata**; the bytes live on disk keyed by `sha256` (dedup: two identical
  files share one blob). `id` is a `cuid()` (domain entity), not the client filename.

### 2. Blobs on a named Docker volume — ordered folder layout

Bytes live as plain files on a new **named volume** (`attachments_data`) mounted on the api service
— the project's existing volume-per-concern pattern (`db_data`, `meili_data`, `caddy_data`). **Not**
Postgres `bytea`, **not** MinIO, **not** external S3 (see [alternatives](#considered-alternatives--rejected)).

**Content-addressed, ordered layout** (CEO explicitly asked for a tidy structure — "que no quede
todo tirado"):

```
/app/attachments/
  <ab>/<sha256>          # blob, sharded by the first 2 hex chars of its sha256
  <cd>/<sha256>          #   → ≤256 top-level dirs, no single directory with 10k+ entries
  tmp/<random>           # in-flight uploads, same volume → finalize = atomic rename
```

- Sharding by `sha256[0:2]` keeps any one directory small and makes `du`/`ls` sane for the operator.
- `tmp/` lives on the **same volume** so promoting a finished upload is a single **atomic `rename()`**
  (no cross-device copy). The blob is written to `tmp/` first, then renamed to `<ab>/<sha256>`.

### 3. Upload path — stream, sniff, blob-first

- **`multer` `diskStorage`** streaming to `attachments/tmp/` — **never** `memoryStorage` (the
  OOM guarantee). Hash on the stream as bytes land.
- **Magic-byte sniff** decides the type — never the client extension or `Content-Type`. The detected
  type must be on the allowlist (and agree with the extension); the **server-derived** MIME is what's
  stored and later served.
- **Allowlist + caps:**
  - Asset documents: `pdf, png, jpg/jpeg, webp, gif, txt, csv, docx, xlsx` — **≤ 25 MB**.
  - KB inline images: `png, jpg/jpeg, gif, webp` — **≤ 10 MB**.
  - **SVG and HTML rejected outright** (stored-XSS vectors). "Export diagrams to PNG."
- **Raster images are re-encoded** via `sharp` in a **BullMQ sandboxed processor**
  ([[0053-async-workers-bullmq-valkey]]) — this strips EXIF/GPS and neutralizes polyglots by
  rewriting the pixels. **PDFs are served as-is** (no rewrite) with an `attachment` disposition.
- **Blob-first write ordering:** write+fsync the blob (tmp → atomic rename to its content path),
  *then* insert the `Attachment` row. A crash between the two leaves an unreferenced blob (the GC
  sweep reclaims it) — never a row pointing at a missing file.
- The **browser POSTs to the API origin directly** (not through the web proxy).

### 4. Serving — API-only, per-parent authz, hardened headers

`GET /assets/:id/attachments/:attId/content` and `GET /articles/:id/images/:imgId` (or the
equivalent), each guarded by the **parent's** permission:

- Asset document → `asset:read`. KB image → the article's visibility check, **including the folder
  ACL** ([[0060-kb-folder-access-control]]) and draft-privacy.
- **404, not 403,** on no-access — no existence leak (the Secret-Manager member-blind pattern).
- Stream with **`StreamableFile` + `createReadStream`** (the existing pattern) — never buffer.
- **Response headers (all mandatory):**
  - `Content-Type` = the **server-derived, allowlisted** MIME stored at upload (never echo the
    client value).
  - `X-Content-Type-Options: nosniff`.
  - `Content-Disposition: attachment` for documents; `inline` **only** for the raster image types
    the KB renders. Filename sanitized (strip CR/LF and quotes; RFC 5987 for unicode).
  - `Content-Security-Policy: default-src 'none'; sandbox`.
  - `Cache-Control: private`.
- **HARD CONSTRAINT:** attachment URLs are served from `/api` and **must never** be a web path
  ending in a media extension — `proxy.ts` `isPublicPath` (line 44) would make them public.

### 5. KB inline images — a post-sanitize rehype renderer, sanitizer never widened

- Authors reference images as `![alt](attachment:<id>)` in Markdown.
- The ref is resolved by an **`img` renderer in the post-sanitize rehype slot** — the same slot that
  already handles wiki-links and secret chips. `SANITIZE_SCHEMA` is **never widened** to allow
  `<img>` through the sanitizer; the image element is injected *after* sanitization, pointing only at
  the authorized same-origin `/api` attachment URL. This keeps SEC-003 /
  [[0029-untrusted-content-sanitization]] discipline **by construction**.
- `img src` is restricted to `attachment:<id>` refs. **External `![](https://…)` image URLs are
  restricted out** (no SSRF / tracking-pixel / arbitrary-remote surface); `data:` and `javascript:`
  are rejected.
- **KB import must round-trip images:** extract the embedded image, upload it through this subsystem,
  rewrite the Markdown ref to `attachment:<id>`. The current importer discards images — this ADR
  fixes that gap, not just new authoring.

### 6. Soft-delete + GC contract (four pins)

Reconciles "never hard-delete" ([[0006-soft-delete-and-auditing]]) with "a single host's disk is
finite," and — critically — Marta's version-restore requirement:

1. **Parent soft-delete does NOT purge blobs.** Soft-deleting an article/asset soft-deletes its
   `Attachment` rows (undo-able); the bytes stay.
2. **The GC reference set is the UNION of:** live article/asset bodies + **soft-deleted** article
   bodies + **ALL `ArticleVersion` snapshots**. Because versions are append-only, *any image ever
   saved in any version is pinned forever* — a version restore can never surface a broken image.
3. **A blob is physically deleted only when NO live `Attachment` row references its `sha256`**
   (dedup-safe: shared blobs survive until the last referrer is gone).
4. **A daily BullMQ sweep** soft-deletes never-referenced orphans past a **24 h grace** (images
   pasted into a draft that was abandoned), then a second pass unlinks blobs no live row references.
   The audit trail (who/when) survives even after the bytes are unlinked.

### 7. Storage guards (single-host)

- Per-file caps as above (§3).
- **`ATTACHMENTS_MAX_TOTAL_MB`** total budget (proposed default **5120** = 5 GB), checked before an
  upload lands. Over budget → a clear **"storage full"** error, **never** a 500 or a half-written
  blob. This is the single-host quota — app-level, no filesystem quotas/cgroups to configure
  (mirrors the `mem_limit` / log-rotation "one thing can't sink the host" guards).

## Consequences

- KB authors get inline images; asset records get their documents; the KB importer stops dropping
  images. The paste-from-clipboard editor flow (below) makes it the tool Marta actually adopts.
- **DR gap (accepted, loud).** `pg_dump` does **not** capture a filesystem volume. Until the v1.1
  backup sidecar extension ships, a host disk loss loses **all attachments** while the DB restores
  cleanly — leaving `Attachment` rows pointing at vanished blobs (which degrade to a broken-file
  placeholder, not a crash, thanks to the soft-ref design). This is the exact pattern the [[backups]]
  runbook exists to prevent, accepted here **only** because the CEO explicitly deferred backup to
  v1.1. The implementation issue **must** add a new DR-table row to [[backups]] stating attachments
  are **NOT covered by any backup yet**, plus a warning callout — a *silent* gap is unacceptable.
  See [Deferred](#deferred).
- The render-time KB sanitizer lands here (closes the SEC-003 latency window at the moment authored
  content first renders as HTML). INV-10 stays intact — no new same-origin XSS surface.
- No new service, no new container, no new credential. One new volume; one new BullMQ sweep + one
  re-encode processor; one new module.
- **Headline UX requirement (constraint for the implementation issues):** paste-from-clipboard image
  upload in the KB editor is **non-negotiable** (Marta's red line — picker-only is strictly worse
  than her current copy-paste flow). Intercept the editor paste event, upload the blob, insert the
  `attachment:<id>` ref at the cursor. Drag-drop and a toolbar file-picker are **secondary**.
- The UI must surface caps **before** a user hits them (Dave's "storage full, contact your admin"
  ask) and expose aggregate attachment storage on an admin/health surface.

## Considered alternatives / rejected

- **Postgres `bytea` (blob table).** The strongest rival — it keeps DR to exactly the existing
  two-DB `pg_dump` with zero new backup surface (the DevOps + security panellists favored it for the
  tired-operator lens). **Rejected: CEO chose the volume** ("Volume filesystem, sin duda"). Honest
  tradeoff recorded: bytea would have made backup free *today*, at the cost of inflating every daily
  `pg_dump` (full, non-incremental) and buffering blobs through the API heap; the volume defers the
  backup work to v1.1 but keeps the DB dump lean and decouples binary bloat from the crown-jewel DB.
- **Bundled MinIO / S3 in compose.** Enterprise machinery — a new container, new credentials in
  `.env.prod`, its own un-dumped volume, an S3 API to integrate — for a few hundred MB at 5–20
  people. Rejected (Dave's red line: no 9th moving part).
- **External S3 as the default.** Violates "no mandatory cloud" ([[0028-secrets-and-config]]). Viable
  only as an **optional, off-by-default driver** later (mirroring `BACKUP_OFFSITE_CMD`) — deferred.
- **ClamAV / AV scanning.** Nothing executes these blobs on the host; the real XSS threat is handled
  by the serving-side controls (§4). ClamAV adds ~300 MB RAM + an outbound signature updater (fights
  the air-gappable self-host model) for a threat this deployment doesn't run. At most an optional
  off-by-default sidecar if a future buyer ever demands the checkbox — never coupling upload success
  to a scanner verdict.
- **Per-blob encryption at rest.** Theater while the DB itself is plaintext, and it would mint a
  **5th unrotatable key linchpin** beside `ZITADEL_MASTERKEY` / `WORKFLOW_SECRET_KEY` /
  `SMTP_SECRET_KEY` / the DB password. If at-rest protection is ever needed, do it once at the host
  layer (full-disk encryption), not per-subsystem.
- **Public / static / signed-URL serving.** Bypasses RBAC and collides with the `proxy.ts`
  media-extension public-bypass. Rejected — every byte passes the parent's authz through `/api`.

## Red lines

- **No `isPublicPath` exposure.** No attachment is ever served on a web path ending in a media
  extension, nor as public static / signed URL. API origin + per-parent authz only.
- **No client-MIME trust.** The served `Content-Type` is the server-derived, allowlisted value;
  `nosniff` is mandatory; type is decided by magic-byte sniff, not extension/header.
- **No SVG, no HTML.** Rejected at upload — never stored, never served.
- **No `memoryStorage`.** Uploads stream to disk; the per-file cap bounds every transfer.
- **The sanitizer lands WITH the first KB image render** — no KB image rendering without the
  [[0029-untrusted-content-sanitization]] render-time allow-list sanitizer in the same change.
- **Never hard-delete a blob still referenced by any restorable version** — the GC reference set
  includes all `ArticleVersion` snapshots; a version restore must never show a broken image.
- **Never use the client filename as a filesystem path or storage key** — blobs are keyed by
  `sha256`; the original name is metadata only.

## Deferred

- **Backup coverage (v1.1 — the named follow-up).** Extend the opt-in backup sidecar
  ([[backups]] "Automated backup") to `tar` the `attachments_data` volume on the same
  `BACKUP_CRON` / `BACKUP_RETENTION_DAYS` / `BACKUP_OFFSITE_CMD` knobs, and add the volume to the DR
  inventory + restore order. Until then the DR-table row and warning callout (added by *this* issue)
  must state loudly that attachments are **not backed up**. This is the accepted-gap → documented-gap
  bargain; it does not stay silent.
- **Optional external-S3 driver.** A future ADR, gated behind an env var (the OIDC BYOI /
  `BACKUP_OFFSITE_CMD` pattern) for larger/multi-host deployments. Keep the storage writer behind a
  thin interface so it slots in without a data-model change; do not build the abstraction speculatively.
- **ClamAV sidecar.** Optional, off-by-default, only if a buyer ever demands it.
- **Attachments on consumables** (calibration certificates, etc.) — Marta's nice-to-have; the
  polymorphic model extends to a `CONSUMABLE` `entityType` when wanted, out of scope for v1.

Related: [[0006-soft-delete-and-auditing]] · [[0025-containerization-strategy]] ·
[[0028-secrets-and-config]] · [[0029-untrusted-content-sanitization]] ·
[[0053-async-workers-bullmq-valkey]] · [[0060-kb-folder-access-control]] ·
[[0061-secret-manager-zero-knowledge]] · [[0062-in-app-help-manual-surface]] · [[backups]]
