"use client";

import { ArrowTopRightOnSquareIcon, DocumentIcon } from "@heroicons/react/24/outline";
import type { Attachment } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAttachmentBlob } from "@/lib/api/endpoints/attachments";
import { previewKind } from "@/lib/purchases/extraction";

/**
 * The document beside the draft (UX proposal §3.b): the browser's own PDF viewer or the image, from the
 * authenticated download turned into an object URL (a bare `src` cannot carry the token, ADR-0082). The bytes
 * are re-typed to the stored, server-sniffed type before they get a URL, and only a PDF or a raster image is
 * shown — never markup. *Open in a new tab* is always there, for a side-by-side window or a small screen.
 */
export function DocumentPreview({ purchaseId, attachment }: { purchaseId: string; attachment: Attachment }) {
  const t = useTranslations("purchases.extraction.preview");
  const preview = previewKind(attachment.mimeType);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!preview) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fetchAttachmentBlob("purchaseOrder", purchaseId, attachment.id, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(new Blob([blob], { type: preview.type }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `preview.type` is derived from the attachment's type, already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseId, attachment.id, attachment.mimeType]);

  return (
    <section aria-label={t("label")} className="flex h-full min-h-[60vh] flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="flex min-w-0 items-center gap-2">
          <DocumentIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{attachment.originalName}</span>
        </p>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("openTab")}
            <ArrowTopRightOnSquareIcon className="size-4" aria-hidden />
          </a>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto rounded-lg border bg-muted/30">
        {!preview ? (
          <p className="p-6 text-sm text-muted-foreground">{t("none")}</p>
        ) : failed ? (
          <p className="p-6 text-sm text-muted-foreground">{t("error")}</p>
        ) : !url ? (
          <Skeleton className="h-full min-h-[60vh] w-full" />
        ) : preview.kind === "pdf" ? (
          <iframe src={url} title={attachment.originalName} className="h-full min-h-[60vh] w-full" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a blob: URL of an authenticated download
          <img src={url} alt={attachment.originalName} className="h-auto max-w-full" />
        )}
      </div>
    </section>
  );
}
