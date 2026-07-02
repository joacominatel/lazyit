import type { Attachment } from "@lazyit/shared";
import { apiFetch, apiFetchBlob } from "../client";

/**
 * Data-access for the polymorphic Attachment subsystem (ADR-0082). One backend model serves two
 * surfaces — documents on an Asset and inline images on a KB Article — behind parallel per-parent
 * routes (`/{assets|articles}/:id/attachments…`), each gated on the PARENT's capability. This module
 * mirrors that shape: an `entity` discriminator picks the base path so the article + asset callers
 * share one implementation.
 *
 * SECURITY: content is served from the API origin behind the parent's authz with hardened headers
 * (`nosniff`, CSP sandbox, `Cache-Control: private`) — NEVER a web path ending in a media extension
 * (that would hit `proxy.ts` `isPublicPath` and bypass the login gate — ADR-0082 red line). Because
 * the API is Bearer-authenticated, an `<img src>`/`<a href>` can't carry the token, so reads go
 * through {@link apiFetchBlob} (Bearer → Blob → object URL), never a bare element `src`.
 */

/** Which parent a set of attachments hangs off — selects the REST base path. */
export type AttachmentParent = "asset" | "article";

/** The REST base for a parent's attachment collection (`/assets/:id/attachments`, …). */
function base(parent: AttachmentParent, parentId: string): string {
  const segment = parent === "asset" ? "assets" : "articles";
  return `/${segment}/${encodeURIComponent(parentId)}/attachments`;
}

/**
 * The authenticated content path for one attachment's bytes (relative to the API base). NOT a
 * browser-loadable `src` on its own (needs the Bearer) — pass it to {@link fetchAttachmentBlob}.
 */
export function attachmentContentPath(
  parent: AttachmentParent,
  parentId: string,
  attachmentId: string,
): string {
  return `${base(parent, parentId)}/${encodeURIComponent(attachmentId)}/content`;
}

/** List a parent's live attachments (metadata only, newest first). 404 → parent not accessible. */
export function listAttachments(
  parent: AttachmentParent,
  parentId: string,
  signal?: AbortSignal,
): Promise<Attachment[]> {
  return apiFetch<Attachment[]>(base(parent, parentId), { signal });
}

/**
 * Upload one file (multipart, field `file`) onto a parent — ADR-0082. The server sniffs the type by
 * magic bytes (never the client MIME), enforces the allowlist + size cap, and returns the created
 * {@link Attachment}. Throws {@link import("../client").ApiError} on reject (413 too large, 415
 * unsupported type, 507 storage full, 404 parent gone) — the caller surfaces the message.
 */
export function uploadAttachment(
  parent: AttachmentParent,
  parentId: string,
  file: File,
): Promise<Attachment> {
  const form = new FormData();
  form.set("file", file);
  return apiFetch<Attachment>(base(parent, parentId), {
    method: "POST",
    body: form,
  });
}

/**
 * Soft-delete an attachment from a parent (blob reclaimed later by the GC sweep — ADR-0082 §6). The
 * API additionally enforces HumanOnly on delete for documents; a service-account token gets a clear
 * 403 the caller surfaces gracefully.
 */
export function deleteAttachment(
  parent: AttachmentParent,
  parentId: string,
  attachmentId: string,
): Promise<Attachment> {
  return apiFetch<Attachment>(
    `${base(parent, parentId)}/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  );
}

/** Fetch an attachment's bytes as a Blob over the authenticated API (for object-URL render / download). */
export function fetchAttachmentBlob(
  parent: AttachmentParent,
  parentId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return apiFetchBlob(attachmentContentPath(parent, parentId, attachmentId), {
    signal,
  });
}
