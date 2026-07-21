"use client";

import { DocumentArrowDownIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/lib/hooks/use-mounted";
import { cn } from "@/lib/utils";
import {
  MARKDOWN_IMPORT_ACCEPT,
  type MarkdownImport,
  parseMarkdownImport,
  validateMarkdownFile,
} from "@/lib/utils/kb-markdown-import";

/**
 * Drag-and-drop (or click-to-choose) markdown import for the KB create form (#1106). Wraps the form
 * body; dropping ONE `.md`/`.markdown`/`.txt` file reads it in-browser via `File.text()` and hands
 * the parsed payload to `onImport` — NO upload, no server round-trip, no new dependency. The caller
 * decides how to apply it (fill the empty editor, or confirm before replacing typed content).
 *
 * Scoped to the CREATE screen by its caller: the edit form's editor owns image drag/drop, so this is
 * only mounted for a brand-new article where there's no image-upload target yet.
 *
 * A11y: besides the drag target there's a focusable, labeled "Choose a .md file" button (the native
 * picker) so keyboard / non-drag users get the same feature. The visual overlay's fade is gated on
 * `prefers-reduced-motion` (`motion-safe:` only), and it's `aria-hidden` decoration — the button and
 * the picker carry the accessible affordance.
 */
export function MarkdownImportDropzone({
  onImport,
  children,
}: {
  onImport: (result: MarkdownImport) => void;
  children: ReactNode;
}) {
  const t = useTranslations("kb.mdImport");
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Drag events fire per child element; a depth counter keeps the overlay steady instead of
  // flickering as the pointer crosses the form's inner nodes (enter/leave both bubble).
  const dragDepth = useRef(0);
  const mounted = useMounted();

  /** Read + validate a single file client-side, then hand the parsed payload up. */
  async function ingest(file: File | null | undefined): Promise<void> {
    if (!file) return;
    const check = validateMarkdownFile(file);
    if (!check.ok) {
      toast.error(check.reason === "size" ? t("toast.tooLarge") : t("toast.wrongType"));
      return;
    }
    // File.text() reads the bytes in the browser — the file is never sent anywhere.
    const text = await file.text();
    onImport(parseMarkdownImport(text, file.name));
  }

  /** Only engage for FILE drags — text/URL drags into the editor keep their normal behavior. */
  function isFileDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) return;
    // Required so the browser accepts the drop instead of navigating to the file.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    // Single-file only (a non-goal to import many) — take the first, ignore the rest.
    void ingest(event.dataTransfer.files?.[0]);
  }

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Discoverability + a11y affordance: a visible hint and a real, focusable file picker. */}
      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2 text-muted-foreground">
          <DocumentArrowDownIcon className="size-4 shrink-0" aria-hidden="true" />
          {t("hint")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => inputRef.current?.click()}
        >
          {t("choose")}
        </Button>
        {/* The picker itself: kept out of the tab order (the button above is the control) but still
            driven by the same import path. Reset value so re-picking the same file re-fires change. */}
        <input
          ref={inputRef}
          type="file"
          accept={MARKDOWN_IMPORT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void ingest(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>

      {children}

      {/* Calm drop overlay. Always mounted (so its opacity can transition), pointer-events-none so
          the drop lands on this container, and its fade only applies with motion-safe (reduced-motion
          users get an instant show). Rendered post-hydration to avoid an SSR/client style flash. */}
      {mounted && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/85 backdrop-blur-sm motion-safe:transition-opacity motion-safe:duration-150",
            dragging ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <DocumentArrowDownIcon className="size-8 text-primary" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">{t("overlay")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
