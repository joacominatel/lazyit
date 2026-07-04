"use client";

import { PrinterIcon } from "@heroicons/react/24/outline";
import { QRCodeSVG } from "qrcode.react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { useMounted } from "@/lib/hooks/use-mounted";

/**
 * Printable QR label for an asset (#875). Lives in the chrome-less `(print)` route group so it prints
 * as a bare label with no app furniture — same shell + auth guard the offboarding Return Act uses.
 *
 * The QR encodes the asset's DEEP-LINK URL (`${origin}/assets/${id}`) built client-side from
 * `window.location.origin`, so the printed code points at whatever origin the operator actually uses —
 * no baked-in config, no backend resolve endpoint. Scanning it just opens the asset page. The
 * human-readable asset tag prints under the QR so a person can still read/type it.
 *
 * Print styling reuses the additive `@media print` block in globals.css: `[data-print-document]`
 * forces a clean white sheet with light tokens, and `[data-print-hide]` drops the on-screen "Print"
 * control. The label is centered and compact on the page.
 */
export default function AssetLabelPage() {
  const t = useTranslations("assets.label");
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: asset, isLoading, isError } = useAsset(id);

  // The deep-link origin is only known in the browser — read it once mounted so the QR encodes the
  // real origin the operator serves from (never an SSR guess). `useMounted` keeps the server HTML and
  // the first client render identical, then reveals the QR on the next render (hydration-safe, no
  // setState-in-effect). Until then we hold the skeleton.
  const mounted = useMounted();
  const origin = mounted ? window.location.origin : "";

  // Name the printed/saved PDF after the asset tag rather than the route path.
  useEffect(() => {
    if (!asset) return;
    const previous = document.title;
    document.title = t("documentTitle", { tag: asset.assetTag ?? asset.name });
    return () => {
      document.title = previous;
    };
  }, [asset, t]);

  if (isError) {
    return (
      <main className="mx-auto max-w-md px-8 py-16 text-sm text-muted-foreground">
        {t("notFound")}
      </main>
    );
  }

  const url = origin ? `${origin}/assets/${id}` : "";
  const ready = !isLoading && !!asset && !!url;

  return (
    <main
      data-print-document
      className="mx-auto flex max-w-sm flex-col items-center px-8 py-10 text-center text-foreground"
    >
      {/* On-screen print control — hidden when printing (see @media print in globals.css). */}
      <div data-print-hide className="mb-8 flex w-full justify-end">
        <Button size="sm" onClick={() => window.print()} disabled={!ready}>
          <PrinterIcon />
          {t("print")}
        </Button>
      </div>

      {ready ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-foreground/15 px-8 py-8">
          <QRCodeSVG
            value={url}
            size={192}
            level="M"
            marginSize={0}
            title={asset.assetTag ?? asset.name}
          />
          {asset.assetTag ? (
            <p className="font-mono text-lg font-semibold tracking-tight tabular-nums">
              {asset.assetTag}
            </p>
          ) : null}
          <p className="max-w-[14rem] text-sm font-medium break-words">
            {asset.name}
          </p>
          <p data-print-hide className="text-xs text-muted-foreground">
            {t("caption")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="size-48" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
      )}
    </main>
  );
}
