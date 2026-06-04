"use client";

import { ClipboardIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DrawnCheck } from "@/components/drawn-check";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * CopyButton — copy an exposed identifier to the clipboard (ADR-0049 «Activated Restraint»).
 *
 * A quiet ghost affordance that sits beside a `font-mono` identifier (asset tag, serial, …).
 * On click it writes `value` via the native Clipboard API, fires a single `toast.success`, and
 * swaps the clipboard glyph for a check that draws once (`--ease-spring`, the reserved success
 * curve) before settling back after ~1.2s. No copy library — `navigator.clipboard` only.
 *
 * SSR-safe (client component) and reduced-motion-safe: the draw collapses to instant via the
 * global `prefers-reduced-motion` guard, and the success state still flips so the affordance
 * reads without any movement. Colour stays disciplined — the check uses `text-success`, a
 * semantic tone on a glyph (never small coloured text), and the resting glyph is muted.
 */
export function CopyButton({
  value,
  label,
  className,
  toastMessage,
}: {
  /** The string written to the clipboard. */
  value: string;
  /** Accessible label, e.g. "Copy asset tag". Also drives the success-state title. */
  label: string;
  className?: string;
  /** Override the success toast text (defaults to "Copied"). */
  toastMessage?: string;
}) {
  const t = useTranslations("shared");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending reset on unmount so we never set state on a gone component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(toastMessage ?? t("copy.copied"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(t("copy.copyError"));
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? t("copy.copiedLabel", { label }) : label}
      title={label}
      onClick={handleCopy}
      className={cn("text-muted-foreground", className)}
    >
      {copied ? (
        <DrawnCheck className="size-3.5 text-success" />
      ) : (
        <ClipboardIcon aria-hidden />
      )}
    </Button>
  );
}
