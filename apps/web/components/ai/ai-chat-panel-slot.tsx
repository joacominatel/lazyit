"use client";

import { ArrowsPointingInIcon, ArrowsPointingOutIcon, XMarkIcon } from "@heroicons/react/24/outline";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  clampPanelWidth,
  isOverlayWidth,
  maxPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  readStoredPanelWidth,
  toggledPanelWidth,
  widthForKey,
  widthFromPointer,
  writeStoredPanelWidth,
} from "@/lib/ai/panel-width";
import { cn } from "@/lib/utils";
import { useAiAssistant } from "./ai-assistant-root";

/** The chat itself (W3-7), loaded on the panel's first open only. */
const AiChatPanel = dynamic(() => import("./ai-chat-panel").then((m) => m.AiChatPanel), {
  ssr: false,
});

/** Tailwind's `md` breakpoint (48rem): below it the panel is a modal sheet. */
const MD_UP = "(min-width: 48rem)";

function subscribeToMdUp(onChange: () => void): () => void {
  const query = window.matchMedia(MD_UP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useIsMdUp(): boolean {
  return useSyncExternalStore(
    subscribeToMdUp,
    () => window.matchMedia(MD_UP).matches,
    () => false,
  );
}

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The viewport width, so a remembered width is re-clamped when the window shrinks. */
function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeToResize,
    () => window.innerWidth,
    () => 0,
  );
}

/** `window.localStorage`, or undefined where reading it throws (blocked site data, some private modes). */
function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Where the AI assistant panel mounts (docs/ai-assistant/frontend.md Fork A, as amended by #1370/#1371):
 * a NON-modal side panel so the page stays live and clickable beside the conversation.
 *
 * - `md` and up, the panel is a `fixed` column on the right edge. At `xl`, at its default width, a spacer
 *   in the layout's flex row reserves the same width so the panel reads as docked and the page reflows
 *   beside it. Wider than the default, the panel OVERLAYS the page (the spacer keeps the default width,
 *   so the page never reflows while it is dragged). From `md` to `xl` it always floats over the page.
 * - Its width is adjustable — a drag handle on its left edge (arrow keys, Home/End, Enter to reset,
 *   double-click to reset) and an Expand / Restore toggle in its header — and remembered per browser.
 * - Below `md` it is a modal full-screen sheet with no resizing.
 *
 * Renders nothing unless the assistant is available AND open. The content is the chat (`AiChatPanel`).
 */
export function AiChatPanelSlot() {
  const t = useTranslations("ai");
  const { available, open, setOpen, launcherRef, panelId } = useAiAssistant();
  const isMdUp = useIsMdUp();
  const viewport = useViewportWidth();
  // The preference is read once, lazily: the slot renders nothing until it opens on the client, so the
  // server markup never depends on it.
  const [preferred, setPreferred] = useState<number>(
    () => readStoredPanelWidth(browserStorage()) ?? PANEL_DEFAULT_WIDTH,
  );
  const [dragging, setDragging] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, [setOpen, launcherRef]);

  const commit = useCallback((next: number) => {
    setPreferred(next);
    writeStoredPanelWidth(browserStorage(), next);
  }, []);

  if (!available || !open) return null;

  const body = <AiChatPanel />;

  if (!isMdUp) {
    return (
      <Sheet open onOpenChange={(next) => !next && close()}>
        <SheetContent
          id={panelId}
          side="right"
          aria-describedby={undefined}
          // The primitive caps its height at `100svh - 2rem` (a floating sheet); the chat fills the screen, so
          // the cap goes — it left a blank strip under the composer on phones (#1370). The chat scrolls inside.
          className="max-h-none w-full gap-0 overflow-hidden p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
        >
          <SheetHeader className="border-b border-border">
            <SheetTitle>{t("panel.title")}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  const width = clampPanelWidth(preferred, viewport);
  const overlay = isOverlayWidth(width);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  function onHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = widthForKey(event.key, event.shiftKey, width, window.innerWidth);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    commit(next);
  }

  function onHandlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onHandlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setPreferred(widthFromPointer(event.clientX, window.innerWidth));
  }

  function onHandlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    commit(widthFromPointer(event.clientX, window.innerWidth));
  }

  return (
    <>
      {/* Reserves the docked width in the layout's flex row at `xl` (the panel itself is `fixed`). */}
      <div aria-hidden className="hidden shrink-0 xl:block" style={{ width: PANEL_DEFAULT_WIDTH }} />
      <aside
        id={panelId}
        aria-label={t("panel.title")}
        onKeyDown={onKeyDown}
        style={{ width }}
        className={cn(
          "fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-border bg-background",
          overlay ? "shadow-lg" : "shadow-lg xl:shadow-none",
          dragging && "select-none",
        )}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-controls={panelId}
          aria-label={t("panel.resize")}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={maxPanelWidth(viewport)}
          aria-valuenow={width}
          aria-valuetext={t("panel.widthValue", { width })}
          title={t("panel.resizeHint")}
          tabIndex={0}
          onKeyDown={onHandleKeyDown}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          onDoubleClick={() => commit(PANEL_DEFAULT_WIDTH)}
          className="group absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none"
        >
          <span
            aria-hidden
            className={cn(
              "h-full w-0.5 bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary",
              dragging && "bg-primary",
            )}
          />
        </div>
        <div className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border px-4">
          <h2 className="text-sm font-medium">{t("panel.title")}</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={overlay ? t("panel.restore") : t("panel.expand")}
              title={overlay ? t("panel.restore") : t("panel.expand")}
              onClick={() => commit(toggledPanelWidth(width, window.innerWidth))}
            >
              {overlay ? <ArrowsPointingInIcon /> : <ArrowsPointingOutIcon />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("panel.close")} onClick={close}>
              <XMarkIcon />
            </Button>
          </div>
        </div>
        {body}
      </aside>
    </>
  );
}
