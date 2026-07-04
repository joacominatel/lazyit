"use client";

import { ArrowLeftIcon, QrCodeIcon } from "@heroicons/react/24/outline";
import type { Html5Qrcode } from "html5-qrcode";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The DOM node html5-qrcode mounts its <video> into — must exist before the instance is created. */
const READER_ID = "asset-qr-reader";

type ScanStatus = "starting" | "scanning" | "error" | "unsupported";

/**
 * Camera QR lookup (#875). Opens the device camera via `html5-qrcode` — a single dependency that
 * bundles its own cross-browser QR decoder, so it works on mobile Safari (iOS) and desktop Firefox
 * where the native `BarcodeDetector` is unavailable. No backend: a decoded lazyit asset deep-link
 * (`${origin}/assets/:id`, same-origin) routes straight to the asset; anything else is treated as a
 * bare asset tag and handed to the EXISTING assets-list search (`/assets?q=…`).
 *
 * Progressive enhancement: needs camera permission + a secure (HTTPS) context. If the camera or the
 * getUserMedia API is unavailable, or the operator denies permission, it degrades to a clear message
 * plus a manual entry field that runs the exact same resolve logic.
 */
export default function AssetScanner() {
  const t = useTranslations("assets.scan");
  const router = useRouter();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // Guards against a second decode firing (and a second navigation) between the first hit and teardown.
  const handledRef = useRef(false);
  const [status, setStatus] = useState<ScanStatus>("starting");
  const [manual, setManual] = useState("");

  /**
   * Route a scanned/typed value. A same-origin `/assets/:id` deep-link opens the asset directly;
   * everything else falls back to the assets-list search — reusing the existing `q` param, no new API.
   */
  const resolveScan = useCallback(
    (text: string) => {
      const raw = text.trim();
      if (!raw) return;
      try {
        const parsed = new URL(raw);
        if (parsed.origin === window.location.origin) {
          const match = parsed.pathname.match(/^\/assets\/([^/]+)\/?$/);
          if (match) {
            router.push(`/assets/${match[1]}`);
            return;
          }
        }
      } catch {
        // Not a URL — treat the payload as a bare asset tag below.
      }
      router.push(`/assets?q=${encodeURIComponent(raw)}`);
    },
    [router],
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // No camera API (older browser, insecure context, or a headless environment) → skip straight to
      // the manual-entry fallback instead of throwing.
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        return;
      }
      const { Html5Qrcode } = await import("html5-qrcode");
      if (cancelled) return;
      const instance = new Html5Qrcode(READER_ID);
      scannerRef.current = instance;
      try {
        await instance.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const edge = Math.floor(
                Math.min(viewfinderWidth, viewfinderHeight) * 0.7,
              );
              return { width: edge, height: edge };
            },
          },
          (decodedText) => {
            if (handledRef.current) return;
            handledRef.current = true;
            instance.stop().catch(() => {});
            resolveScan(decodedText);
          },
          undefined,
        );
        if (cancelled) {
          await instance.stop().catch(() => {});
          return;
        }
        setStatus("scanning");
      } catch {
        // Permission denied, no camera, or an insecure (non-HTTPS) origin — all land here.
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      const instance = scannerRef.current;
      scannerRef.current = null;
      if (instance) {
        instance
          .stop()
          .then(() => instance.clear())
          .catch(() => {});
      }
    };
  }, [resolveScan]);

  function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    resolveScan(manual);
  }

  const showViewfinder = status === "starting" || status === "scanning";

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeader
        title={t("title")}
        pillar="inventory"
        icon={QrCodeIcon}
        subtitle={t("subtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/assets">
              <ArrowLeftIcon />
              {t("back")}
            </Link>
          </Button>
        }
      />

      {/* The viewfinder host. Kept mounted while starting/scanning so html5-qrcode always has its
          target node; the library injects the <video> here. */}
      {showViewfinder ? (
        <div className="space-y-3">
          <div
            id={READER_ID}
            className="overflow-hidden rounded-lg border bg-muted [&_video]:w-full"
          />
          <p className="text-center text-sm text-muted-foreground">
            {status === "starting" ? t("starting") : t("permissionHint")}
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-4 text-center text-sm text-muted-foreground">
          {status === "unsupported" ? t("unsupported") : t("error")}
        </p>
      )}

      {/* Manual fallback — always available so a broken/denied camera never traps the operator. Runs
          the same resolve logic as a scan. */}
      <form onSubmit={handleManualSubmit} className="space-y-2">
        <Label htmlFor="asset-scan-manual">{t("manualLabel")}</Label>
        <div className="flex gap-2">
          <Input
            id="asset-scan-manual"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            placeholder={t("manualPlaceholder")}
            autoComplete="off"
          />
          <Button type="submit" disabled={!manual.trim()}>
            {t("manualSubmit")}
          </Button>
        </div>
      </form>
    </div>
  );
}
