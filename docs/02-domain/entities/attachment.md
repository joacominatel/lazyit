---
title: Attachment
tags: [domain, entity, attachments, storage]
status: accepted
created: 2026-07-01
updated: 2026-07-01
---

# Attachment

> 🟢 implemented · Area: cross-cutting (Assets + Knowledge Base) · [[0082-attachments-storage]]

## Purpose

A **user-uploaded file** on a parent record — lazyit's first binary-upload subsystem
([[0082-attachments-storage]], issue #876/#906). One polymorphic model serves two surfaces:

- **Documents on an [[asset]]** — warranty PDFs, receipts, damage photos (Dave's Drive-folder pain).
- **Inline images in a KB [[article]]** — `![alt](attachment:<id>)` in the Markdown body (Marta's
  paste-a-screenshot flow; the importer round-trips them).

The row is **metadata only**. The bytes live on the api's `attachments_data` Docker volume as
`attachments/<sha[0:2]>/<sha256>` — content-addressed, so **two identical files share one blob**
(dedup) — never in Postgres, never on a public/static path.

> [!warning] Attachments are NOT backed up yet (deferred v1.1 by decision — ADR-0082)
> `pg_dump` restores the rows but not the bytes; see the DR table + callout in [[backups]].
> A row whose blob vanished degrades to a clean 404, never a crash (the soft-ref design).

## Relationships

- **hangs off** one parent via `(entityType, entityId)` — a **soft ref, NO FK** (the KB-chip /
  `InfraNodeSecretRef` house style): the parent (`ASSET` → [[asset]], `ARTICLE` → [[article]]) is
  validated **live at attach time**; a dangling ref degrades gracefully. `CONSUMABLE` is a deferred
  extension.
- **uploaded by** an optional [[user]] (`uploadedById`, `onDelete: SetNull`) — the file outlives its
  uploader; a [[service-account]] cannot upload (403, mirroring article authorship).

## Business rules

- **AuthZ is the PARENT's rule, per request.** Asset docs: `asset:read` / `asset:write`. Article
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

## Fields

Prisma model `Attachment` → table `attachments`. Wire schema (`AttachmentSchema`) + allowlists/caps
live in `@lazyit/shared` (`packages/shared/src/schemas/attachment.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `entityType` | `enum AttachmentEntityType` | `ASSET` \| `ARTICLE`. |
| `entityId` | `string` | soft ref → the parent's id, **no FK**. |
| `sha256` | `string` | content hash = the on-disk blob key (dedup); indexed. |
| `byteSize` | `int` | size of the stored blob. |
| `mimeType` | `string` | **server-derived**, allowlisted — the served Content-Type. |
| `originalName` | `string` | client filename — metadata only, never a path/key. |
| `uploadedById` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull`. |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | mutable domain entity ([[0006-soft-delete-and-auditing]]); registered in the soft-delete read filter. |

Indexes: `@@index([entityType, entityId])` (per-parent list), `@@index([sha256])` (dedup/GC).

## Endpoints

`apps/api/src/attachments/` (`AttachmentsModule`).

| Route | Gate | Purpose |
| --- | --- | --- |
| `POST /assets/:id/attachments` · `POST /articles/:id/attachments` | parent write | multipart single-file upload |
| `GET /assets/:id/attachments` · `GET /articles/:id/attachments` | parent read | live metadata list |
| `GET …/attachments/:attId/content` | parent read | hardened byte stream |
| `DELETE …/attachments/:attId` | parent write | soft delete |
