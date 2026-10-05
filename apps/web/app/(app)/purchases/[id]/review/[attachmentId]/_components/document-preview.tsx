"use client";

import { ArrowTopRightOnSquareIcon, DocumentIcon } from "@heroicons/react/24/outline";
import type { Attachment } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAttachmentBlob } from "@/lib/api/endpoints/attachments";
import { previewKind } from "@/lib/purchases/extraction";

/**
 * The document beside the draft (UX proposal §3.b), from the authenticated download turned into an object URL
 * (a bare `src` cannot carry the token, ADR-0082). The bytes are re-typed to the stored, server-sniffed type
 * before they get a URL — never markup. A raster image is shown inline (`img-src` allows `blob:`). A PDF is
 * NOT framed: the web CSP keeps `frame-src 'none'` (ADR-0099, Phase 2 web), so it is a document card whose
 * *Open in a new tab* opens it in the browser's own viewer, beside the review.
 */
export function DocumentPreview({
  purchaseId,
  attachment,
  reading = false,
}: {
  purchaseId: string;
  attachment: Attachment;
  reading?: boolean;
}) {
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
        // Unmounted (or another document) meanwhile: never mint a URL nobody will revoke.
        if (controller.signal.aborted) return;
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
    <section
      aria-label={t("label")}
      className={preview?.kind === "image" ? "flex h-full min-h-[60vh] flex-col gap-2" : "flex flex-col gap-2"}
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="flex min-w-0 items-center gap-2">
          <DocumentIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{attachment.originalName}</span>
        </p>
        {url && preview?.kind === "image" ? (
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
      <div className={preview?.kind === "image" ? "relative flex min-h-0 flex-1 flex-col" : "relative"}>
        <div
          className={
            preview?.kind === "image"
              ? "flex min-h-0 flex-1 items-start justify-center overflow-auto rounded-lg border bg-muted/30"
              : "flex items-start justify-center rounded-lg border bg-muted/30"
          }
        >
          {!preview ? (
            <p className="p-6 text-sm text-muted-foreground">{t("none")}</p>
          ) : failed ? (
            <p className="p-6 text-sm text-muted-foreground">{t("error")}</p>
          ) : preview.kind === "pdf" ? (
            <div className="flex w-full flex-col items-center gap-3 p-8 text-center">
              <DocumentIcon className="size-10 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">{t("pdfHelp")}</p>
              <Button asChild={url !== null} disabled={url === null} size="sm">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <ArrowTopRightOnSquareIcon />
                    {t("openTab")}
                  </a>
                ) : (
                  <span>{t("openTab")}</span>
                )}
              </Button>
            </div>
          ) : !url ? (
            <Skeleton className="h-full min-h-[60vh] w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a blob: URL of an authenticated download
            <img src={url} alt={attachment.originalName} className="h-auto max-w-full" />
          )}
        </div>
        {reading && preview ? (
          <div
            aria-hidden
            data-scan
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg motion-reduce:hidden"
          >
            <div className="animate-doc-scan" />
          </div>
        ) : null}
      </div>
    </section>
  );
}
