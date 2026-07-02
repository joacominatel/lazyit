"use client";

import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  DocumentIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { Attachment } from "@lazyit/shared";
import { ASSET_ATTACHMENT_MAX_MB, ASSET_ATTACHMENT_MIME_TYPES } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type DragEvent, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAttachmentBlob } from "@/lib/api/endpoints/attachments";
import {
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
} from "@/lib/api/hooks/use-attachments";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";

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
  const t = useTranslations("attachments");
  const { date } = useFormatters();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useAttachments("asset", assetId);
  const upload = useUploadAttachment("asset", assetId);
  const remove = useDeleteAttachment("asset", assetId);
  const items = data ?? [];

  function uploadFiles(files: File[]) {
    for (const file of files) {
      upload.mutate(file, {
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
      const blob = await fetchAttachmentBlob("asset", assetId, attachment.id);
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
        {canWrite ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("docs.hint", { max: ASSET_ATTACHMENT_MAX_MB })}
          </p>
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
                <div className="flex min-w-0 items-center gap-3">
                  <DocumentIcon
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {attachment.originalName}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {formatBytes(attachment.byteSize)} ·{" "}
                      {date(attachment.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
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
              {t("docs.deleteConfirmDescription", {
                name: pendingDelete?.originalName ?? "",
              })}
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
