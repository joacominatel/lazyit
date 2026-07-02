import { z } from "zod";
import { int4 } from "./primitives";

/**
 * Attachment — a user-uploaded file hanging off an Asset (documents: warranty PDFs, receipts,
 * damage photos) or an Article (inline KB images) — ADR-0082. One polymorphic model serves both
 * surfaces; the row is METADATA ONLY (the bytes live on the api's `attachments_data` volume, keyed
 * by `sha256` — dedup: identical files share one blob). `entityId` is a soft ref (no FK); the parent
 * is validated live at attach time. Single source of truth for api and web.
 *
 * SECURITY (the ADR's red lines, enforced server-side; mirrored here so the web can pre-validate):
 * - `mimeType` is SERVER-DERIVED by magic-byte sniff — never the client extension or Content-Type.
 * - SVG and HTML are rejected outright (stored-XSS vectors) — never stored, never served.
 * - Content is served from the API origin only (`/api/...`), behind the PARENT's authz, with
 *   hardened headers (`nosniff`, CSP sandbox, `Cache-Control: private`).
 */

/** Which parent kind an Attachment hangs off. Extendable (CONSUMABLE is deferred — ADR-0082). */
export const AttachmentEntityTypeSchema = z.enum(["ASSET", "ARTICLE"]);

/** Per-file size cap for ASSET documents (ADR-0082 §3). */
export const ASSET_ATTACHMENT_MAX_MB = 25;
/** Per-file size cap for ARTICLE inline images (ADR-0082 §3). */
export const ARTICLE_IMAGE_MAX_MB = 10;

/**
 * The server-derived MIME allowlist for ASSET documents (ADR-0082 §3):
 * pdf, png, jpg/jpeg, webp, gif, txt, csv, docx, xlsx. SVG/HTML are rejected outright.
 */
export const ASSET_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** The server-derived MIME allowlist for ARTICLE inline images (ADR-0082 §3). */
export const ARTICLE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/**
 * The only MIME types ever served with `Content-Disposition: inline` (the raster images the KB
 * renders — ADR-0082 §4). Everything else is `attachment` (download), PDFs included.
 */
export const ATTACHMENT_INLINE_MIME_TYPES = ARTICLE_IMAGE_MIME_TYPES;

/**
 * How Markdown references an uploaded KB image (ADR-0082 §5): `![alt](attachment:<id>)`. The web's
 * post-sanitize renderer resolves the ref to the authorized same-origin `/api` content URL; external
 * / `data:` / `javascript:` image URLs are restricted out.
 */
export const ATTACHMENT_REF_PREFIX = "attachment:";

/**
 * Parse an `attachment:<id>` Markdown image ref to the attachment id, or `null` when `src` is not
 * an attachment ref (an external URL, `data:`, …). Pure — used by the web renderer and the KB
 * import round-trip; the id itself is validated against the DB by the content endpoint's authz.
 */
export function attachmentRefId(src: string): string | null {
  if (!src.startsWith(ATTACHMENT_REF_PREFIX)) return null;
  const id = src.slice(ATTACHMENT_REF_PREFIX.length);
  return /^[a-z0-9]+$/i.test(id) ? id : null;
}

/**
 * A single Attachment row (API representation of the `attachments` row) — the shape returned by the
 * upload (POST …/attachments), the per-parent list (GET …/attachments) and the delete. Date fields
 * are ISO-8601 strings (the wire shape). `uploadedById` is null once the uploader is hard-deleted
 * (SetNull) — attribution degrades, the file survives. Soft-deleted rows never surface.
 *
 * NOTE: `sha256`/`byteSize`/`mimeType` may change shortly after upload for raster images — the
 * sandboxed re-encode (EXIF strip / polyglot neutralization, ADR-0082 §3) replaces the blob
 * best-effort. `id` and the content URL are stable.
 */
export const AttachmentSchema = z.object({
  id: z.cuid(),
  entityType: AttachmentEntityTypeSchema,
  entityId: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: int4({ min: 0 }),
  mimeType: z.string().min(1),
  originalName: z.string().min(1),
  uploadedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AttachmentEntityType = z.infer<typeof AttachmentEntityTypeSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
