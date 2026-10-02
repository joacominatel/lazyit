/**
 * The optional document type label of an asset or purchase document (ADR-0099 §10, #1476) — free text
 * ("Invoice", "Delivery note"), never a closed list. Pure, so the field → wire rules are tested without React.
 */

import { ATTACHMENT_LABEL_MAX_LENGTH } from "@lazyit/shared";

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
