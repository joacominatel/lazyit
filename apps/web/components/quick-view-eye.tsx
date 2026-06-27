"use client";

import { EyeIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
} from "react";
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
 * semantics). It is the radix `PopoverAnchor`, so Escape closes the panel and returns focus to the cmdk
 * input ({@link QuickViewPopover} restores it). One open at a time is enforced by the lifted
 * `openQuickViewId` in the host picker.
 *
 * KEYBOARD-OPEN (#793): the eye is `tabIndex={-1}` (cmdk owns roving focus — DOM focus stays on the
 * CommandInput), so it is not a Tab stop. The keyboard path is the non-conflicting **Alt+Enter** chord
 * wired on the `<Command>` root via {@link quickViewChordKeyDown}: it opens + pins the currently
 * HIGHLIGHTED row's preview without fighting cmdk's roving focus. The eye also keeps an `onKeyDown` for
 * the mouse-then-keyboard case (a focused eye); `aria-keyshortcuts` advertises the chord to AT.
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
          // The Alt+Enter chord (quickViewChordKeyDown, wired on the Command root) opens this row's
          // preview by keyboard; advertise it to AT on the control it activates (#793).
          aria-keyshortcuts="Alt+Enter"
          // cmdk owns roving focus (DOM focus stays on the CommandInput); keep the eye out of the Tab
          // order so it doesn't fight that model — the keyboard path is the chord, not a Tab stop.
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

/**
 * The keyboard-open path for Quick View (#793): a non-conflicting **Alt+Enter** chord wired on the cmdk
 * `<Command>` root's `onKeyDown`. It opens + pins the currently HIGHLIGHTED row's preview — the one
 * thing cmdk's roving focus otherwise blocks (cmdk keeps DOM focus on the input and routes plain Enter
 * to the highlighted row's `onSelect`).
 *
 * Safe against cmdk by construction: cmdk calls a passed `onKeyDown` BEFORE its own handler and skips
 * that handler entirely when the event is `defaultPrevented`. Calling `preventDefault()` here on
 * Alt+Enter suppresses cmdk's row-select for the chord ONLY — plain Enter, the arrows and type-to-filter
 * never match this branch and pass straight through untouched.
 *
 * The highlighted row id is read from the live DOM — the `data-quick-view-id` on the selected
 * `[cmdk-item]` — never by parsing cmdk's client-filter value string (which is `"label id"`). Each host
 * stamps that attribute on rows that have a preview; a highlighted row without one is a no-op.
 */
export function quickViewChordKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  pin: (id: string) => void,
) {
  if (event.key !== "Enter" || !event.altKey) return;
  // Alt+Enter is the preview chord — never let it fall through to cmdk's row-select.
  event.preventDefault();
  const selected = event.currentTarget.querySelector<HTMLElement>(
    '[cmdk-item][aria-selected="true"]',
  );
  const id = selected?.getAttribute("data-quick-view-id");
  if (id) pin(id);
}

/**
 * A small, muted footer hint advertising the {@link quickViewChordKeyDown} Alt+Enter chord inside the
 * picker popovers (Combobox / EntityMultiSelect), for discoverability. Render it only when the picker
 * actually has eyes (a `quickView` callback + visible rows); the command palette has its own footer hint.
 */
export function QuickViewHint() {
  const t = useTranslations("common.quickView");
  return (
    <div className="flex items-center gap-1 border-t px-3 py-1.5 text-xs text-muted-foreground">
      <kbd className="rounded border bg-muted px-1 font-mono text-[0.6875rem]">
        Alt
      </kbd>
      <kbd className="rounded border bg-muted px-1 font-mono text-[0.6875rem]">
        ↵
      </kbd>
      <span className="ml-0.5">{t("keyboardHint")}</span>
    </div>
  );
}
