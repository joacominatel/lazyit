"use client";

import { EyeIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { titleFor, type QuickViewData } from "@/components/quick-view-fields";
import { QuickViewPopover } from "@/components/quick-view-popover";
import { cn } from "@/lib/utils";

/**
 * The per-row Quick View eye affordance (epic #788, ADR-0072), lifted out of {@link Combobox} in wave 2
 * (#790) so the multi-select sibling {@link EntityMultiSelect} reuses the SAME button — one definition
 * of the hover/pin/keyboard interaction across both pickers, never two drifting copies.
 *
 * The host picker owns the single-open state (`open`/`pinned` lifted to the picker so only ONE preview
 * shows at a time across all rows) and supplies the `onPreview`/`onPin`/`onClose` callbacks; this
 * component owns only the hover-intent timer and the eye `<button>` itself.
 */

/** Intent delay (ms) before a hover opens the Quick View preview — long enough that skimming the
 *  list with the mouse doesn't flicker previews, short enough to feel instant on a deliberate hover. */
const QUICK_VIEW_HOVER_MS = 120;

/**
 * The per-row eye affordance (ADR-0072). A real `<button>` (not a hover-only glyph): it is `opacity-0`
 * and revealed by `group-hover/row` OR `group-data-[selected=true]/row` — so it is keyboard-VISIBLE on
 * the cmdk-selected row (arrow-key roving selection), not just on mouse hover. It is its own button
 * that `stopPropagation`/`preventDefault`s so activating it NEVER selects the row.
 *
 * Hover (after a ~120ms intent delay) opens a transient PREVIEW; click PINS it (footer + dialog
 * semantics). It is the radix `PopoverAnchor`, so Escape closes the panel and returns focus here for
 * free (radix default). One open at a time is enforced by the lifted `openQuickViewId` in the host picker.
 *
 * KEYBOARD-OPEN is a documented v1 LIMITATION (#793): cmdk keeps DOM focus on the CommandInput and routes
 * Enter to the highlighted row's `onSelect`, so the eye — though visible on the selected row — can't be
 * opened by keyboard without fighting that roving-focus model. The eye keeps an `onKeyDown` for the
 * mouse-then-keyboard case (a focused eye), but a pure-keyboard user can't yet open the preview. The
 * clean fix (Tab-reachable selected-row eye, or a non-conflicting Command-root chord) is the follow-up.
 */
export function QuickViewEye({
  view,
  open,
  pinned,
  onPreview,
  onPin,
  onClose,
}: {
  view: QuickViewData;
  open: boolean;
  pinned: boolean;
  onPreview: () => void;
  onPin: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("common.quickView");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearHoverTimer() {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  // Clean up a pending intent timer if the row unmounts mid-hover.
  useEffect(() => clearHoverTimer, []);

  return (
    <QuickViewPopover
      view={view}
      open={open}
      pinned={pinned}
      onOpenChange={(next) => {
        // Radix drives this on Escape / outside-click — collapse our lifted state to match.
        if (!next) onClose();
      }}
      anchor={
        <button
          type="button"
          aria-label={t("trigger", { name: titleFor(view) })}
          // cmdk owns roving focus (DOM focus stays on the CommandInput); keep the eye out of the Tab
          // order so it doesn't fight that model. It's reached by mouse today; a keyboard-open path is
          // the documented v1 limitation / follow-up (#793).
          tabIndex={-1}
          className={cn(
            "flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100",
            open && "opacity-100",
          )}
          onMouseEnter={() => {
            clearHoverTimer();
            hoverTimer.current = setTimeout(onPreview, QUICK_VIEW_HOVER_MS);
          }}
          onMouseLeave={() => {
            clearHoverTimer();
            // Only a transient preview auto-dismisses on leave; a pinned one stays.
            if (open && !pinned) onClose();
          }}
          onClick={(event) => {
            // Don't let the click bubble to cmdk and select the row — the eye is a separate action.
            event.preventDefault();
            event.stopPropagation();
            clearHoverTimer();
            // Toggle: clicking the eye of an already-pinned preview closes it.
            if (open && pinned) onClose();
            else onPin();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              clearHoverTimer();
              if (open && pinned) onClose();
              else onPin();
            }
          }}
        >
          <EyeIcon className="size-4" />
        </button>
      }
    />
  );
}
