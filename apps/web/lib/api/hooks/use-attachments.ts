import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Attachment } from "@lazyit/shared";
import {
  type AttachmentParent,
  deleteAttachment,
  listAttachments,
  uploadAttachment,
} from "../endpoints/attachments";
import { purchaseOrderKeys } from "./use-purchase-orders";

/**
 * React-Query hooks for the Attachment subsystem (ADR-0082). One set of hooks serves both parents
 * (asset documents + article images) — the `parent` discriminator threads into the query key and the
 * endpoint base path. Mutations invalidate the parent's list so the section refreshes on upload/delete.
 */

export const attachmentKeys = {
  all: ["attachments"] as const,
  list: (parent: AttachmentParent, parentId: string) =>
    [...attachmentKeys.all, parent, parentId] as const,
};

/**
 * List a parent's live attachments (metadata only). Idle until a `parentId` is provided (a not-yet-
 * saved KB draft has none). The list feeds both the asset documents panel and the KB image
 * filename→alt map (`AttachmentImage`).
 */
export function useAttachments(
  parent: AttachmentParent,
  parentId: string | undefined,
) {
  return useQuery({
    queryKey: attachmentKeys.list(parent, parentId ?? ""),
    queryFn: ({ signal }) => listAttachments(parent, parentId as string, signal),
    enabled: Boolean(parentId),
  });
}

/**
 * After an upload or delete: the parent's list, and for a purchase also its reads — the activity log
 * records the document (ADR-0099) and linked assets list the same rows in their provenance.
 */
function useInvalidateParent(parent: AttachmentParent, parentId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: attachmentKeys.list(parent, parentId) });
    if (parent === "purchaseOrder") void qc.invalidateQueries({ queryKey: purchaseOrderKeys.all });
  };
}

/** Upload a file onto a parent; invalidates the parent's list so the new row appears. */
export function useUploadAttachment(
  parent: AttachmentParent,
  parentId: string,
) {
  const invalidate = useInvalidateParent(parent, parentId);
  return useMutation({
    mutationFn: (file: File) => uploadAttachment(parent, parentId, file),
    onSuccess: invalidate,
  });
}

/** Soft-delete an attachment; invalidates the parent's list. */
export function useDeleteAttachment(
  parent: AttachmentParent,
  parentId: string,
) {
  const invalidate = useInvalidateParent(parent, parentId);
  return useMutation({
    mutationFn: (attachmentId: string): Promise<Attachment> =>
      deleteAttachment(parent, parentId, attachmentId),
    onSuccess: invalidate,
  });
}
