---
title: Attachment
tags: [domain, entity, attachments, storage]
status: accepted
created: 2026-07-01
updated: 2026-10-02
---

# Attachment

> 🟢 implemented · Area: cross-cutting (Assets + Knowledge Base + Purchases) · [[0082-attachments-storage]]

## Purpose

A **user-uploaded file** on a parent record — lazyit's first binary-upload subsystem
([[0082-attachments-storage]], issue #876/#906). One polymorphic model serves three surfaces:

- **Documents on an [[asset]]** — warranty PDFs, receipts, damage photos (Dave's Drive-folder pain).
- **Inline images in a KB [[article]]** — `![alt](attachment:<id>)` in the Markdown body (Marta's
  paste-a-screenshot flow; the importer round-trips them).
- **Documents on a [[purchase-order]]** — quotes, orders, invoices, delivery notes (#1473; see *Purchase
  documents* below).

The row is **metadata only**. The bytes live on the api's `attachments_data` Docker volume as
`attachments/<sha[0:2]>/<sha256>` — content-addressed, so **two identical files share one blob**
(dedup) — never in Postgres, never on a public/static path.

> [!warning] Attachments are NOT backed up yet (deferred v1.1 by decision — ADR-0082)
> `pg_dump` restores the rows but not the bytes; see the DR table + callout in [[backups]].
> A row whose blob vanished degrades to a clean 404, never a crash (the soft-ref design). This now
> includes **purchase documents** (invoices, orders, delivery notes): the attachments backup that
> ADR-0099 §12 made a Purchases prerequisite has not shipped — #1467 is open, deferred by the CEO — and the
> purchase's documents panel says the files are not in the backup.

## Relationships

- **hangs off** one parent via `(entityType, entityId)` — a **soft ref, NO FK** (the KB-chip /
  `InfraNodeSecretRef` house style): the parent (`ASSET` → [[asset]], `ARTICLE` → [[article]]) is
  validated **live at attach time**; a dangling ref degrades gracefully. `CONSUMABLE` is a deferred
  extension. `PURCHASE_ORDER` → [[purchase-order]] is built (#1473; see the note under Business rules).
- **uploaded by** an optional [[user]] (`uploadedById`, `onDelete: SetNull`) — the file outlives its
  uploader; a [[service-account]] cannot upload (403, mirroring article authorship).

## Business rules

- **AuthZ is the PARENT's rule, per request.** Asset docs: `asset:read` / `asset:write`. Purchase docs:
  `purchaseOrder:read` / `purchaseOrder:write`, on a live purchase. Article
  images: the article's full visibility gate on reads (draft privacy [[0022-draft-visibility-auth-shim]]
  + folder ACL [[0060-kb-folder-access-control]]) and the edit gate on writes (author / ADMIN /
  `article:manage`). **404, never 403**, on no-access — no existence leak.
- **Server-derived type only.** `mimeType` comes from a magic-byte sniff against a fixed allowlist
  (asset docs: pdf png jpg webp gif txt csv docx xlsx, ≤ 25 MB; article images: png jpg gif webp,
  ≤ 10 MB); the client's Content-Type/extension is never trusted, and **SVG/HTML are rejected
  outright** (stored-XSS red line). Served with `nosniff`, CSP `default-src 'none'; sandbox`,
  `Cache-Control: private`, `Content-Disposition: attachment` (inline only for raster images).
- **Blob-first write.** Streamed to `tmp/` on the same volume (multer diskStorage — never memory),
  hashed, atomically renamed to its sha path, **then** the row is inserted. A crash in between
  leaves an unreferenced blob for the GC — never a row without bytes.
- **Raster re-encode.** png/jpg/webp/gif are re-encoded by a sandboxed sharp worker after upload
  (strips EXIF/GPS, neutralizes polyglots; best-effort — failure keeps the original). `sha256` /
  `byteSize` change in place; `id` and the content URL are stable.
- **Storage budget.** `ATTACHMENTS_MAX_TOTAL_MB` (default 5120) — an upload past it is a clean
  **507 "storage full"**, never a 500 or a partial write.
- **Soft delete + the four-pin GC** ([[0006-soft-delete-and-auditing]] reconciled with a finite
  disk): delete stamps `deletedAt`; the daily BullMQ sweep (24 h grace) soft-deletes
  never-referenced article images, then unlinks a blob **only** when no live row shares its sha AND
  no article body (live **or soft-deleted**) or [[article-version]] snapshot references any of its
  rows — a version restore can never surface a broken image. The metadata row survives the bytes as
  the audit trail.

> [!note] Purchase documents — built (#1473, [[0099-purchases-scope-model-and-optionality]] §10)
> The parent type **`PURCHASE_ORDER`** (an enum value appended at the tail) reuses the asset documents
> allowlist and 25 MB cap — the same `SURFACE` entry — gated by `purchaseOrder:read` / `:write`, with the
> same 404 for a missing or archived parent. Routes: `POST|GET /purchase-orders/:id/attachments`,
> `GET …/:attachmentId/content`, `DELETE …/:attachmentId` (`PurchaseOrderAttachmentsController`). Writes are
> human-only, like asset documents, and also append `DOCUMENT_ADDED` / `DOCUMENT_REMOVED` to the
> [[purchase-order-event]] log in the same transaction as the row. A purchase's documents are **shared, not
> copied**: the same rows are listed read-only on every asset linked to the purchase through
> `GET /assets/:id/purchase` — to principals holding `purchaseOrder:read` only (ADR-0099 §8, CEO decision
> D-A) — and downloaded through the purchase's content route; upload and delete happen on the purchase. The
> GC treats them like asset documents: pinned by their own live row, reclaimed after an explicit delete.
> The optional free-text type label (quote, invoice, delivery note) is built (#1476): see *Document type
> label* below. Because they are financial evidence, ADR-0099 §12 made the **attachments backup a
> prerequisite** shipping before or alongside Phase 1; it has **not** shipped (#1467, open, deferred by the
> CEO), so the documents panel warns that the files are not in the backup (see the warning above).
>
> A purchase document of a type the configured provider reads (PDF or image) can also be **read by the AI**
> into a draft of the purchase — `POST /purchase-orders/:id/attachments/:attachmentId/extract` (#1477,
> [[purchase-order]] *Fill from a document*). The extraction reads the stored bytes; it never changes or
> re-saves the attachment.

### Document type label (#1476)

[[0099-purchases-scope-model-and-optionality]] §10. An asset or purchase document may carry an optional
free-text **type label** — quote, order, invoice, delivery note, whatever the team writes. Never a closed or
required list (CEO decision D-D).

- **Set at upload** through the multipart `label` text field (trimmed; blank = no label; at most 100
  characters, `400` beyond). The service validates it inside the upload's `try`, so a bad label still
  discards the staged tmp file.
- **Edited later** with `PATCH /assets/:id/attachments/:attId` (`asset:write`) or
  `PATCH /purchase-orders/:id/attachments/:attId` (`purchaseOrder:write`), body `{ label: string | null }`
  (`null` or a blank one clears it, as on upload). Only the label is editable — never the file, its name or its type. Human-only, like
  every attachment write; `404` for a document of another parent or of an archived purchase. On a purchase,
  a real change appends `DOCUMENT_UPDATED { attachmentId, originalName, label: { from, to } }` in the same
  transaction; `DOCUMENT_ADDED` / `DOCUMENT_REMOVED` carry the `label` too.
- **Returned** on every list, upload and delete, and on the documents of an asset's purchase provenance.
- **Suggested** by smart entry: `GET /suggestions/documentLabel` merges the labels of live asset documents
  (under `asset:read`) and of live purchase documents (under `purchaseOrder:read`), each source only for a
  live parent; a caller with neither permission gets `403`.
- **Untrusted text** ([[0029-untrusted-content-sanitization]]): stored verbatim, rendered as plain text, never
  as HTML. Article images take no label (the KB has no use for one).

## Fields

Prisma model `Attachment` → table `attachments`. Wire schema (`AttachmentSchema`) + allowlists/caps
live in `@lazyit/shared` (`packages/shared/src/schemas/attachment.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `entityType` | `enum AttachmentEntityType` | `ASSET` \| `ARTICLE` \| `PURCHASE_ORDER` (#1473). |
| `entityId` | `string` | soft ref → the parent's id, **no FK**. |
| `sha256` | `string` | content hash = the on-disk blob key (dedup); indexed. |
| `byteSize` | `int` | size of the stored blob. |
| `mimeType` | `string` | **server-derived**, allowlisted — the served Content-Type. |
| `originalName` | `string` | client filename — metadata only, never a path/key. |
| `uploadedById` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull`. |
| `label` | `string?` | optional document type label (#1476); `NULL` on every row that predates it. |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | mutable domain entity ([[0006-soft-delete-and-auditing]]); registered in the soft-delete read filter. |

Indexes: `@@index([entityType, entityId])` (per-parent list), `@@index([sha256])` (dedup/GC).

## Endpoints

`apps/api/src/attachments/` (`AttachmentsModule`).

| Route | Gate | Purpose |
| --- | --- | --- |
| `POST /assets/:id/attachments` · `POST /articles/:id/attachments` · `POST /purchase-orders/:id/attachments` | parent write | multipart single-file upload |
| `GET /assets/:id/attachments` · `GET /articles/:id/attachments` · `GET /purchase-orders/:id/attachments` | parent read | live metadata list |
| `GET …/attachments/:attId/content` | parent read | hardened byte stream |
| `PATCH /assets/:id/attachments/:attId` · `PATCH /purchase-orders/:id/attachments/:attId` | parent write | set or clear the document type label (#1476) |
| `DELETE …/attachments/:attId` | parent write | soft delete |
