"use client";

import { useTranslations } from "next-intl";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { useMounted } from "@/lib/hooks/use-mounted";
import { cn } from "@/lib/utils";

/**
 * Lightbox — click any inline visual to enlarge it in a native `<dialog>` (#1106 Phase 1). No
 * dependency: `<dialog>.showModal()` gives us the modal, the focus trap, the top layer, and Esc-to-
 * close for free; a click on the dialog element itself (i.e. its `::backdrop` region) closes it.
 * Motion is gated behind `motion-safe:` so `prefers-reduced-motion` gets an instant open/close.
 *
 * The `<dialog>` is PORTALED to `document.body`: a markdown image is wrapped by react-markdown in a
 * `<p>` (and a linked image in an `<a>`), and `<dialog>` is flow content the parser hoists out of a
 * `<p>` — so an inline `<dialog>` produced `<p>…<dialog></p>` and, because `/help/[slug]` SSRs this
 * client component, a React 19 hydration mismatch on the Manual. Portaling keeps the `<dialog>` off
 * the inline flow; only the phrasing-content trigger stays where the image was. The portal mounts
 * after hydration, so SSR emits just the trigger.
 *
 * `inline` picks the trigger element: a `<span role="button">` for images (phrasing content — valid
 * inside the `<p>`/`<a>` an image sits in, and it keeps the text flow), a `<button>` for block
 * triggers like a mermaid diagram surface (never inside a `<p>`/`<a>`).
 */
export function Lightbox({
  children,
  zoomed,
  label,
  className,
  inline = false,
}: {
  /** The inline preview that becomes the clickable trigger. */
  children: ReactNode;
  /** The enlarged content shown inside the dialog. */
  zoomed: ReactNode;
  /** Accessible label for the trigger and the dialog (e.g. "Enlarge"). */
  label: string;
  className?: string;
  /** Render the trigger as an inline `<span role="button">` (valid inside `<p>`/`<a>`). */
  inline?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const mounted = useMounted();

  const open = () => ref.current?.showModal();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };

  const triggerClass = cn(
    "cursor-zoom-in appearance-none border-0 bg-transparent p-0 text-left",
    className,
  );

  return (
    <>
      {inline ? (
        // ponytail: a linked image (`[![]()]()`) would both navigate and open the lightbox — rare in
        // IT docs; the `<span>` keeps the DOM valid (a `<button>` can't be an `<a>` descendant).
        <span
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={onKeyDown}
          aria-label={label}
          className={cn("inline-block align-middle", triggerClass)}
        >
          {children}
        </span>
      ) : (
        <button
          type="button"
          onClick={open}
          aria-label={label}
          className={cn("block", triggerClass)}
        >
          {children}
        </button>
      )}
      {mounted &&
        createPortal(
          <dialog
            ref={ref}
            aria-label={label}
            // A click that lands on the dialog element itself is a backdrop click (the content sits
            // in the inner wrapper) → close. Content clicks target descendants and are ignored.
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
          </dialog>,
          document.body,
        )}
    </>
  );
}

/**
 * ImageZoom — a raster image that opens in the {@link Lightbox} on click. Shared by the KB
 * `AttachmentImage` (authenticated blob object URL) and the Manual `img` renderer (static src). The
 * same `src`/`alt` drive both the thumbnail and the enlarged copy, so alt text is preserved and no
 * second fetch happens. `inline` keeps the trigger valid inside the `<p>`/`<a>` an image sits in.
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
      inline
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
