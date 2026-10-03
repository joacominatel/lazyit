"use client";

import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  DocumentIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { Attachment } from "@lazyit/shared";
import {
  ASSET_ATTACHMENT_MAX_MB,
  ASSET_ATTACHMENT_MIME_TYPES,
  ATTACHMENT_LABEL_MAX_LENGTH,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type DragEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SuggestInput, useRecentValues } from "@/components/suggest-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { type AttachmentParent, fetchAttachmentBlob } from "@/lib/api/endpoints/attachments";
import {
  useAttachments,
  useDeleteAttachment,
  useUpdateAttachmentLabel,
  useUploadAttachment,
} from "@/lib/api/hooks/use-attachments";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";
import { labelFits, labelPatch, planUpload } from "@/lib/utils/document-label";

/** The DOM id of a document row's "edit type" pencil — where focus returns when its editor closes. */
const pencilId = (attachmentId: string) => `doc-label-edit-${attachmentId}`;

/** The smart-entry store for document type labels — shared by the upload field and the inline edit. */
const LABEL_RECENT_KEY = "attachment.label";

/** The `accept` attribute for the asset-document picker — the ADR-0082 §3 allowlist (server sniffs too). */
const ACCEPT = ASSET_ATTACHMENT_MIME_TYPES.join(",");

/** Compact, locale-free byte-size label (KB/MB) — small enough not to warrant a shared util yet. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Documents section on the asset detail page (ADR-0082): upload (button + drag-drop), list (name,
 * size, date), download (authenticated content URL → object URL) and delete (confirm; the API
 * enforces HumanOnly — surfaced gracefully). Content is fetched over the Bearer-authenticated API
 * and NEVER a public media path (red line): a bare `<a href>`/`<img>` can't carry the token, so
 * downloads go Bearer → Blob → object URL.
 *
 * `canWrite` (asset:write) gates upload + delete; a read-only viewer sees the list and can download.
 */
export function AssetDocumentsPanel({
  assetId,
  canWrite,
}: {
  assetId: string;
  canWrite: boolean;
}) {
  return <DocumentsPanel parent="asset" parentId={assetId} canWrite={canWrite} />;
}

/**
 * The same documents section for any parent sharing the asset allowlist — the asset, and a purchase
 * (ADR-0099 §10: `purchaseOrder:read` lists and downloads, `purchaseOrder:write` uploads and deletes).
 * `notice` renders under the header, e.g. the purchase's "not in the backup" warning (§12).
 *
 * Each document may carry an optional type label (#1476) — "Invoice", "Delivery note" — typed with smart
 * entry over `/suggestions/documentLabel`: set it in the optional *Type* field before uploading (it applies
 * to the files of that upload) or edit it inline on the row; emptying it clears it. Never required.
 *
 * `rowAction` adds an action to a document's row — a purchase's *Read this document* (#1477).
 */
export function DocumentsPanel({
  parent,
  parentId,
  canWrite,
  notice,
  rowAction,
}: {
  parent: Extract<AttachmentParent, "asset" | "purchaseOrder">;
  parentId: string;
  canWrite: boolean;
  notice?: ReactNode;
  rowAction?: (attachment: Attachment) => ReactNode;
}) {
  const t = useTranslations("attachments");
  const { date } = useFormatters();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useAttachments(parent, parentId);
  const upload = useUploadAttachment(parent, parentId);
  const remove = useDeleteAttachment(parent, parentId);
  const items = data ?? [];
  // The optional type label for the next upload, and the row whose label is being edited.
  const [nextLabel, setNextLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Closing a row's label editor gives focus back to that row's pencil (the editor focuses its own input).
  const refocusPencilRef = useRef<string | null>(null);
  useEffect(() => {
    if (editingId === null && refocusPencilRef.current) {
      document.getElementById(pencilId(refocusPencilRef.current))?.focus();
      refocusPencilRef.current = null;
    }
  }, [editingId]);
  const labelSuggestions = useSuggestions("documentLabel", nextLabel, { enabled: canWrite });
  const [, rememberLabel] = useRecentValues(LABEL_RECENT_KEY);
  const nextLabelFits = labelFits(nextLabel);

  function uploadFiles(files: File[]) {
    // A label too long to store is refused on its field before any upload is attempted.
    if (!nextLabelFits) {
      toast.error(t("docs.labelTooLong", { max: ATTACHMENT_LABEL_MAX_LENGTH }));
      return;
    }
    // Client-side guard (the server sniffs + enforces too, ADR-0082 §3) — skip an oversized or wrong-type
    // file with a clear toast instead of firing a doomed request.
    const { accepted, refused, label, consumeLabel } = planUpload(files, nextLabel);
    for (const { file, reason } of refused) {
      toast.error(
        reason === "tooLarge"
          ? t("docs.tooLarge", { name: file.name, max: ASSET_ATTACHMENT_MAX_MB })
          : t("docs.invalidType", { name: file.name }),
      );
    }
    // The label applies to the files of this upload only, so the next one does not inherit it by mistake —
    // but only once a file actually goes up; a refused drop keeps what was typed.
    if (consumeLabel) {
      if (label) rememberLabel(label);
      setNextLabel("");
    }
    for (const file of accepted) {
      upload.mutate({ file, label }, {
        onSuccess: () => toast.success(t("docs.uploaded", { name: file.name })),
        onError: (error) => notifyError(error, t("docs.uploadError")),
      });
    }
  }

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) uploadFiles(files);
    event.target.value = ""; // allow re-picking the same file
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canWrite) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) uploadFiles(files);
  }

  async function download(attachment: Attachment) {
    setDownloadingId(attachment.id);
    try {
      const blob = await fetchAttachmentBlob(parent, parentId, attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.originalName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      notifyError(error, t("docs.downloadError"));
    } finally {
      setDownloadingId(null);
    }
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    remove.mutate(target.id, {
      onSuccess: () => {
        toast.success(t("docs.deleted", { name: target.originalName }));
        setPendingDelete(null);
      },
      onError: (error) => {
        notifyError(error, t("docs.deleteError"));
        setPendingDelete(null);
      },
    });
  }

  return (
    <DetailPanel
      title={t("docs.title")}
      actions={
        canWrite ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
            >
              <ArrowUpTrayIcon />
              {t("docs.upload")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              aria-label={t("docs.upload")}
              onChange={onPick}
            />
          </>
        ) : undefined
      }
    >
      <div
        onDragOver={
          canWrite
            ? (e) => {
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  setDragging(true);
                }
              }
            : undefined
        }
        onDragLeave={canWrite ? () => setDragging(false) : undefined}
        onDrop={canWrite ? onDrop : undefined}
        className={cn(
          "rounded-lg transition-colors",
          dragging && "outline-2 outline-dashed outline-primary/60 outline-offset-2",
        )}
      >
        {notice}
        {canWrite ? (
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {t("docs.hint", { max: ASSET_ATTACHMENT_MAX_MB })}
            </p>
            <div className="w-full space-y-1 sm:w-56">
              <Label htmlFor={`${parent}-doc-next-label`} className="text-xs text-muted-foreground">
                {t("docs.nextLabel")}
              </Label>
              <SuggestInput
                id={`${parent}-doc-next-label`}
                value={nextLabel}
                onValueChange={setNextLabel}
                source={() => labelSuggestions}
                recentKey={LABEL_RECENT_KEY}
                placeholder={t("docs.labelPlaceholder")}
                aria-invalid={nextLabelFits ? undefined : true}
                className="h-8"
              />
            </div>
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">{t("docs.loadError")}</p>
        ) : items.length === 0 ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <DocumentIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{t("docs.empty")}</p>
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <DocumentIcon
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2">
                      {attachment.label && editingId !== attachment.id ? (
                        // Untrusted free text (ADR-0029): rendered as text, never as HTML.
                        <Badge variant="outline" className="max-w-40 shrink-0 truncate">
                          {attachment.label}
                        </Badge>
                      ) : null}
                      <span className="truncate font-medium">{attachment.originalName}</span>
                    </p>
                    {editingId === attachment.id ? (
                      <LabelEditor
                        parent={parent}
                        parentId={parentId}
                        attachment={attachment}
                        onDone={() => {
                          refocusPencilRef.current = attachment.id;
                          setEditingId(null);
                        }}
                      />
                    ) : (
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {formatBytes(attachment.byteSize)} ·{" "}
                        {date(attachment.createdAt)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {rowAction?.(attachment)}
                  {canWrite && editingId !== attachment.id ? (
                    <Button
                      id={pencilId(attachment.id)}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("docs.editLabelAria", { name: attachment.originalName })}
                      onClick={() => setEditingId(attachment.id)}
                    >
                      <PencilSquareIcon />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("docs.downloadAria", {
                      name: attachment.originalName,
                    })}
                    onClick={() => download(attachment)}
                    disabled={downloadingId === attachment.id}
                  >
                    <ArrowDownTrayIcon />
                  </Button>
                  {canWrite ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("docs.deleteAria", {
                        name: attachment.originalName,
                      })}
                      onClick={() => setPendingDelete(attachment)}
                    >
                      <TrashIcon />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("docs.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                parent === "purchaseOrder"
                  ? "docs.deleteConfirmDescriptionPurchase"
                  : "docs.deleteConfirmDescription",
                { name: pendingDelete?.originalName ?? "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("docs.deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={remove.isPending}
            >
              {t("docs.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  );
}

/**
 * Inline edit of one document's type label (#1476): smart entry over the labels already used, Enter or
 * *Save* sends only a change, and an emptied field clears the label.
 */
function LabelEditor({
  parent,
  parentId,
  attachment,
  onDone,
}: {
  parent: Extract<AttachmentParent, "asset" | "purchaseOrder">;
  parentId: string;
  attachment: Attachment;
  onDone: () => void;
}) {
  const t = useTranslations("attachments");
  const [text, setText] = useState(attachment.label ?? "");
  const suggestions = useSuggestions("documentLabel", text);
  const [, rememberLabel] = useRecentValues(LABEL_RECENT_KEY);
  const update = useUpdateAttachmentLabel(parent, parentId);
  const fits = labelFits(text);
  const inputId = `doc-label-${attachment.id}`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!fits) return;
    const data = labelPatch(text, attachment.label);
    if (!data) {
      onDone();
      return;
    }
    update.mutate(
      { attachmentId: attachment.id, data },
      {
        onSuccess: () => {
          rememberLabel(data.label);
          toast.success(t(data.label === null ? "docs.labelCleared" : "docs.labelSaved"));
          onDone();
        },
        onError: (error) => notifyError(error, t("docs.labelError")),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-1 flex items-center gap-1">
      <label htmlFor={inputId} className="sr-only">
        {t("docs.label")}
      </label>
      <SuggestInput
        id={inputId}
        value={text}
        onValueChange={setText}
        source={() => suggestions}
        recentKey={LABEL_RECENT_KEY}
        placeholder={t("docs.labelPlaceholder")}
        aria-invalid={fits ? undefined : true}
        className="h-8"
        autoFocus
      />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label={t("docs.saveLabel")} disabled={update.isPending || !fits}>
        <CheckIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("docs.cancelLabel")} onClick={onDone} disabled={update.isPending}>
        <XMarkIcon />
      </Button>
    </form>
  );
}
