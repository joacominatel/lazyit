"use client";

import dynamic from "next/dynamic";

/**
 * /assets/scan — camera QR lookup (#875). A thin client shell whose ONLY job is the `ssr:false`
 * boundary: the scanner pulls in `html5-qrcode` (camera + a bundled cross-browser QR decoder that
 * works on iOS Safari / Firefox where the native `BarcodeDetector` is missing), which must never run
 * on the server and never bloat the initial bundle. It is loaded client-only, on demand.
 */
const AssetScanner = dynamic(() => import("./_components/asset-scanner"), {
  ssr: false,
});

export default function AssetScanPage() {
  return <AssetScanner />;
}
