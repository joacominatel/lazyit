"use client";

import { ArrowLeftIcon, QrCodeIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { CameraViewfinder } from "@/components/camera-viewfinder";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCameraScanner } from "@/lib/hooks/use-camera-scanner";

/** The DOM node html5-qrcode mounts its <video> into — must exist before the instance is created. */
const READER_ID = "asset-qr-reader";

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
  const tc = useTranslations("common.cameraScanner");
  const router = useRouter();
  // Guards against a second decode firing (and a second navigation) between the first hit and teardown.
  const handledRef = useRef(false);
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

  // The camera session (shared with the serials scanner of Receive stock, #1476): one read is enough here.
  const { status, feedback } = useCameraScanner(READER_ID, (decodedText, stop) => {
    if (handledRef.current) return false;
    handledRef.current = true;
    stop();
    resolveScan(decodedText);
    return true;
  });

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
          <CameraViewfinder
            readerId={READER_ID}
            feedback={feedback}
            scanningLabel={tc("scanning")}
            className="rounded-lg border"
          />
          <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
            {status === "starting"
              ? `${t("starting")} ${t("permissionHint")}`
              : feedback === "success"
                ? t("found")
                : feedback === "tip"
                  ? tc("tip")
                  : t("hint")}
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
