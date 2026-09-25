"use client";

import { ArrowTopRightOnSquareIcon, QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** How long the pointer may travel from the "?" to the bubble before a hover-opened tip closes. */
const HOVER_CLOSE_DELAY_MS = 150;

/**
 * A "?" help tip (#1407): the longer explanation of a setting, kept off the page until asked for, with
 * an optional "Learn more" link into the in-app Manual. Built on the Popover primitive so it works
 * everywhere, not only with a mouse:
 *   - a mouse hover opens it (and it stays open while the pointer is over the bubble);
 *   - a click, a tap or Enter/Space on the focusable trigger opens it "pinned" — it then stays until
 *     Escape, an outside click, or a second press — so touch and keyboard users read it at their pace,
 *     and a keyboard user can Tab into the "Learn more" link;
 *   - the trigger is a real button, named "More about {topic}", ≥24px (WCAG 2.5.8).
 * The content is not rendered while closed, so a tip never duplicates text for a screen reader.
 */
export function HelpTip({
  topic,
  href,
  children,
  className,
}: {
  /** What the tip explains — becomes the trigger's accessible name ("More about {topic}"). */
  topic: string;
  /** A Manual page (optionally with an #anchor) holding the full explanation. */
  href?: string;
  children: ReactNode;
  className?: string;
}) {
  const t = useTranslations("common.helpTip");
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelClose() {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  useEffect(() => cancelClose, []);

  function onPointerEnter(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    setOpen(true);
  }

  function onPointerLeave(event: PointerEvent) {
    if (event.pointerType !== "mouse" || pinned.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }

  function onOpenChange(next: boolean) {
    cancelClose();
    if (!next) pinned.current = false;
    setOpen(next);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        type="button"
        aria-label={t("label", { topic })}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onClick={(event) => {
          // Handled here instead of by the primitive's toggle: a click on a tip the hover already
          // opened PINS it rather than closing it under the pointer.
          event.preventDefault();
          cancelClose();
          if (open && !pinned.current) {
            pinned.current = true;
            return;
          }
          pinned.current = !open;
          setOpen(!open);
        }}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground",
          className,
        )}
      >
        <QuestionMarkCircleIcon className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm leading-relaxed"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // A hover-opened tip must not steal focus from wherever the keyboard is.
        onOpenAutoFocus={(event) => {
          if (!pinned.current) event.preventDefault();
        }}
      >
        <div className="space-y-2 text-popover-foreground">{children}</div>
        {href ? (
          <Link
            href={href}
            prefetch={false}
            // A new tab, so a half-filled settings form is never navigated away from.
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("learnMore")}
            <ArrowTopRightOnSquareIcon className="size-3.5" aria-hidden />
            <span className="sr-only">{t("newTab")}</span>
          </Link>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
