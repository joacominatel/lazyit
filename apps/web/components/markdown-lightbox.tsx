"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Lightbox — click any inline visual to enlarge it in a native `<dialog>` (#1106 Phase 1). No
 * dependency: `<dialog>.showModal()` gives us the modal, the focus trap, the top layer, and Esc-to-
 * close for free; a click on the dialog element itself (i.e. its `::backdrop` region) closes it.
 * Motion is gated behind `motion-safe:` so `prefers-reduced-motion` gets an instant open/close.
 *
 * Used by the KB inline image (`AttachmentImage`), the Manual's static images (the `img` renderer),
 * and mermaid diagrams — each passes the inline `children` (the trigger) and the enlarged `zoomed`
 * content. It carries no state and never fetches, so re-rendering the same content twice is cheap.
 */
export function Lightbox({
  children,
  zoomed,
  label,
  className,
}: {
  /** The inline preview that becomes the clickable trigger. */
  children: ReactNode;
  /** The enlarged content shown inside the dialog. */
  zoomed: ReactNode;
  /** Accessible label for the trigger and the dialog (e.g. "Enlarge"). */
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        aria-label={label}
        className={cn(
          "block cursor-zoom-in appearance-none border-0 bg-transparent p-0 text-left",
          className,
        )}
      >
        {children}
      </button>
      <dialog
        ref={ref}
        aria-label={label}
        // A click that lands on the dialog element itself is a backdrop click (the content sits in
        // the inner wrapper) → close. Content clicks target descendants and are ignored.
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
        className={cn(
          "m-auto max-h-[92vh] max-w-[92vw] rounded-lg border bg-background p-2 text-foreground shadow-xl",
          "backdrop:bg-black/70 motion-safe:transition-opacity motion-safe:duration-150",
        )}
      >
        <div className="flex max-h-[calc(92vh-1rem)] items-center justify-center overflow-auto">
          {zoomed}
        </div>
      </dialog>
    </>
  );
}

/**
 * ImageZoom — a raster image that opens in the {@link Lightbox} on click. Shared by the KB
 * `AttachmentImage` (authenticated blob object URL) and the Manual `img` renderer (static src). The
 * same `src`/`alt` drive both the thumbnail and the enlarged copy, so alt text is preserved and no
 * second fetch happens.
 */
export function ImageZoom({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const t = useTranslations("shared");
  return (
    <Lightbox
      label={t("lightbox.zoom")}
      zoomed={
        // next/image can't load a runtime authenticated blob: URL, and the Manual's images are
        // static repo assets — a plain <img> is correct in both cases.
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={alt}
          className="h-auto max-h-[86vh] w-auto max-w-full rounded"
        />
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={cn(
          "my-2 h-auto max-w-full rounded-md border border-border",
          className,
        )}
      />
    </Lightbox>
  );
}
