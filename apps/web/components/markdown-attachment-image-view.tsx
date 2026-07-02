"use client";

import { PhotoIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { fetchAttachmentBlob } from "@/lib/api/endpoints/attachments";
import { useAttachments } from "@/lib/api/hooks/use-attachments";
import { cn } from "@/lib/utils";

/**
 * The React side of the KB inline image (ADR-0082 §5). The post-sanitize `rehypeAttachmentImages`
 * pass (`markdown-attachment-image.ts`) mints an `attachmentimg` element carrying the attachment id;
 * `MarkdownView` maps it to {@link AttachmentImage}. Resolving that id to actual bytes needs the
 * PARENT article's id (the content route is `/articles/:articleId/attachments/:id/content`), which
 * the generic renderer doesn't know — so a page supplies it via {@link ArticleAttachmentProvider}.
 *
 * Bytes are fetched over the authenticated API (Bearer → Blob → object URL): the content endpoint is
 * gated on the article's read authz and never a public media path, so a bare `<img src>` can't load
 * it (no token). Without a provider (e.g. the not-yet-saved `/kb/new` preview, or the public Manual)
 * an image degrades to a calm inline placeholder rather than a broken box.
 */

interface ArticleAttachmentContextValue {
  articleId: string;
  /** Attachment id → its original filename, for alt text (ADR-0082: alt = filename). */
  nameFor: (id: string) => string | undefined;
}

const ArticleAttachmentContext =
  createContext<ArticleAttachmentContextValue | null>(null);

/**
 * Provide the article context every inline image renders against. Fetches the article's attachment
 * list once (metadata only) so each image can label itself with its filename; the list also refetches
 * after an editor upload (shared query key) so a freshly-pasted image gets its real alt text.
 */
export function ArticleAttachmentProvider({
  articleId,
  children,
}: {
  articleId: string;
  children: ReactNode;
}) {
  const { data } = useAttachments("article", articleId);
  const nameFor = (id: string) =>
    data?.find((attachment) => attachment.id === id)?.originalName;

  return (
    <ArticleAttachmentContext.Provider value={{ articleId, nameFor }}>
      {children}
    </ArticleAttachmentContext.Provider>
  );
}

/**
 * Render one `attachment:<id>` inline image. Reads the article context, fetches the blob over the
 * authenticated API, and shows it as a lazily-decoded object URL — with a placeholder while loading
 * / when unresolvable and a muted "broken" note on error. The object URL is revoked on unmount / id
 * change so we never leak blob URLs.
 */
export function AttachmentImage({ attachment }: { attachment?: string }) {
  const t = useTranslations("attachments");
  const ctx = useContext(ArticleAttachmentContext);
  // Single id-tagged result so setState happens ONLY in the async callbacks (never synchronously in
  // the effect body). Until `result.id` matches the current attachment we render the placeholder, so
  // a changed id never briefly shows the previous image.
  const [result, setResult] = useState<{
    id: string;
    url: string | null;
    failed: boolean;
  } | null>(null);

  const articleId = ctx?.articleId;
  const attachmentId = attachment;

  useEffect(() => {
    // No parent context (unsaved draft preview / Manual) or no id → stay in the placeholder state.
    if (!articleId || !attachmentId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAttachmentBlob("article", articleId, attachmentId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ id: attachmentId, url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ id: attachmentId, url: null, failed: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [articleId, attachmentId]);

  const alt =
    (attachmentId ? ctx?.nameFor(attachmentId) : undefined) ?? t("image.alt");

  // Only trust the result once it belongs to the current attachment id.
  const ready = result !== null && result.id === attachmentId;
  const url = ready ? result.url : null;
  const failed = ready && result.failed;

  if (failed) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-sm text-muted-foreground"
        data-attachment="broken"
      >
        <PhotoIcon className="size-4 shrink-0" aria-hidden />
        {t("image.broken")}
      </span>
    );
  }

  if (!url) {
    // Loading, or no provider (draft/manual) — a calm skeleton block, never a broken-image box.
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-sm text-muted-foreground",
          articleId && attachmentId && "animate-pulse",
        )}
        data-attachment="loading"
      >
        <PhotoIcon className="size-4 shrink-0" aria-hidden />
        {articleId && attachmentId ? t("image.loading") : t("image.unavailable")}
      </span>
    );
  }

  return (
    // next/image can't load a runtime authenticated blob: object URL, so a plain img is correct here.
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      className="my-2 h-auto max-w-full rounded-md border border-border"
    />
  );
}
