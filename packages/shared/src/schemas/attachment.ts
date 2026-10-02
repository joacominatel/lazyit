import { z } from "zod";
import { int4, optionalText } from "./primitives";

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

/**
 * Which parent kind an Attachment hangs off. Extendable (CONSUMABLE is deferred — ADR-0082).
 * `PURCHASE_ORDER` (ADR-0099 §10, #1473): a purchase's documents — quote, order, invoice, delivery note —
 * under the ASSET allowlist and size cap, gated by `purchaseOrder:read` / `:write`, and listed read-only on
 * every asset linked to the purchase (to the same permission).
 */
export const AttachmentEntityTypeSchema = z.enum(["ASSET", "ARTICLE", "PURCHASE_ORDER"]);

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
  // The optional document type label (#1476). Nullish: older rows and builds lack it.
  label: z.string().nullish(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** The longest document type label accepted on write: a label ("Delivery note"), not a description. */
export const ATTACHMENT_LABEL_MAX_LENGTH = 100;

/**
 * The optional free-text TYPE LABEL of an asset or purchase document (ADR-0099 §10, #1476): quote, order,
 * invoice, delivery note — whatever the team writes. Never a closed or required list; smart entry suggests
 * labels already used (`GET /suggestions/documentLabel`). Untrusted text (ADR-0029): stored verbatim and
 * rendered as text, never as HTML.
 *
 * As the `label` field of the multipart upload: trimmed, blank = no label.
 */
export const AttachmentLabelSchema = optionalText(ATTACHMENT_LABEL_MAX_LENGTH);

/**
 * `PATCH /assets/:assetId/attachments/:attachmentId` and `PATCH /purchase-orders/:id/attachments/:attachmentId`:
 * set the document's type label, or clear it with `null`. Only the label is editable; the file never is.
 */
export const UpdateAttachmentSchema = z.strictObject({
  label: z.string().trim().min(1).max(ATTACHMENT_LABEL_MAX_LENGTH).nullable(),
});

export type AttachmentEntityType = z.infer<typeof AttachmentEntityTypeSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type UpdateAttachment = z.infer<typeof UpdateAttachmentSchema>;
