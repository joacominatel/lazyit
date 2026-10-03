/**
 * The optional document type label of an asset or purchase document (ADR-0099 §10, #1476) — free text
 * ("Invoice", "Delivery note"), never a closed list. Pure, so the field → wire rules are tested without React.
 */

import { ASSET_ATTACHMENT_MAX_MB, ASSET_ATTACHMENT_MIME_TYPES, ATTACHMENT_LABEL_MAX_LENGTH } from "@lazyit/shared";

/** The label sent with an upload: the trimmed text, or nothing at all when blank (no label). */
export function uploadLabel(text: string): string | undefined {
  const label = text.trim();
  return label === "" ? undefined : label;
}

/**
 * The `PATCH …/attachments/:id` body for an inline edit: the trimmed label, or `null` when the field was
 * emptied (a blank label clears it). `null` when nothing changed — no request is needed.
 */
export function labelPatch(text: string, current: string | null | undefined): { label: string | null } | null {
  const label = text.trim() === "" ? null : text.trim();
  return label === (current ?? null) ? null : { label };
}

/** Whether the typed label fits what the API stores; a longer one is refused on the field, never cut. */
export function labelFits(text: string): boolean {
  return text.trim().length <= ATTACHMENT_LABEL_MAX_LENGTH;
}

/** Why the client refused a file before uploading it (the server sniffs and enforces too, ADR-0082 §3). */
export type UploadRefusal = "tooLarge" | "invalidType";

/**
 * One upload of documents with the optional type typed for it: the files that pass the client-side guards
 * (size cap, a declared type on the allowlist), the ones refused and why, and the label they carry. The typed
 * label is CONSUMED — remembered as a recent value and cleared from its field — only when at least one file
 * goes up: a refused drop must not swallow what the operator typed.
 */
export function planUpload<F extends { size: number; type: string }>(
  files: readonly F[],
  labelText: string,
): { accepted: F[]; refused: { file: F; reason: UploadRefusal }[]; label: string | undefined; consumeLabel: boolean } {
  const accepted: F[] = [];
  const refused: { file: F; reason: UploadRefusal }[] = [];
  for (const file of files) {
    if (file.size > ASSET_ATTACHMENT_MAX_MB * 1024 * 1024) refused.push({ file, reason: "tooLarge" });
    else if (file.type && !(ASSET_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type))
      refused.push({ file, reason: "invalidType" });
    else accepted.push(file);
  }
  return { accepted, refused, label: uploadLabel(labelText), consumeLabel: accepted.length > 0 };
}
