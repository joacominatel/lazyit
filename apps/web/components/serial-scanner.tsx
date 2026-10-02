"use client";

import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCameraScanner } from "@/lib/hooks/use-camera-scanner";
import { type LastScan, scanStep } from "@/lib/utils/scanned-serials";

/**
 * Scan serial numbers with the camera into a serials box (ADR-0099 Phase 1b, UX proposal §6, #1476) — the
 * `/assets/scan` camera (`useCameraScanner`) reading the barcodes on hardware boxes (Code 128 / 39, EAN, UPC,
 * QR…). It scans continuously: each new code goes to `onScan` with a short tick (and a vibration where the
 * phone has one), a code held in front of the camera stays silent however long it stays there, and a code
 * already in the box is reported (once it comes back into view), never added twice. *Done* closes it; the box stays editable throughout.
 *
 * Without a camera, without permission or outside HTTPS it says so and the box is typed as before.
 */
export function SerialScanner({
  existing,
  onScan,
  onDone,
}: {
  /** The serials already in the box (parsed), to report duplicates. */
  existing: readonly string[];
  onScan: (code: string) => void;
  onDone: () => void;
}) {
  const t = useTranslations("common.serialScanner");
  // A unique host per mount: html5-qrcode looks the node up by id.
  const readerId = `serial-reader-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const existingRef = useRef(existing);
  const lastRef = useRef<LastScan>(null);
  const [added, setAdded] = useState<{ code: string; count: number } | null>(null);
  // Focus lands on *Done* when the scanner opens, so the keyboard and screen readers are where the session
  // ends; the caller returns focus to *Scan* when it closes.
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    doneRef.current?.focus();
  }, []);

  useEffect(() => {
    existingRef.current = existing;
  }, [existing]);

  const status = useCameraScanner(
    readerId,
    (text) => {
      // Every sighting refreshes "last seen", so a code held in view stays silent (scanStep).
      const { decision, last } = scanStep(text, {
        existing: existingRef.current,
        last: lastRef.current,
        now: Date.now(),
      });
      lastRef.current = last;
      const code = text.trim();
      if (decision === "invalid" || decision === "repeat") return;
      if (decision === "duplicate") {
        toast.info(t("duplicate", { code }));
        return;
      }
      // Counted here as well: the parent's list catches up on its next render.
      existingRef.current = [...existingRef.current, code];
      onScan(code);
      setAdded((prev) => ({ code, count: (prev?.count ?? 0) + 1 }));
      navigator.vibrate?.(40);
    },
    "barcodes",
  );

  const live = status === "starting" || status === "scanning";

  return (
    <div className="space-y-2 rounded-md border p-2">
      {live ? (
        <div id={readerId} className="overflow-hidden rounded-md bg-muted [&_video]:w-full" />
      ) : (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-sm text-muted-foreground">
          {status === "unsupported" ? t("unsupported") : t("error")}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-muted-foreground" role="status" aria-live="polite">
          {added ? (
            <span className="inline-flex items-center gap-1 text-foreground">
              <CheckCircleIcon className="size-4 shrink-0 text-success" aria-hidden />
              <span className="truncate">{t("added", { code: added.code, count: added.count })}</span>
            </span>
          ) : status === "starting" ? (
            t("starting")
          ) : live ? (
            t("hint")
          ) : null}
        </p>
        <Button ref={doneRef} type="button" variant="outline" size="sm" onClick={onDone}>
          {t("done")}
        </Button>
      </div>
    </div>
  );
}
