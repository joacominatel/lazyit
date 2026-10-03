import type { Metadata } from "next";
import { PurchasesGate } from "./_components/purchases-gate";

// Static section title for the `%s · lazyit` template (see the consumables layout for why it lives here).
export const metadata: Metadata = { title: "Purchases" };

/**
 * The Purchases area (ADR-0099): every route under `/purchases` renders only for a caller holding
 * `purchaseOrder:read` — VIEWER is denied by default. The API guards every read; this keeps the area from
 * showing a screen of 403s to someone who reached it by URL.
 */
export default function PurchasesLayout({ children }: { children: React.ReactNode }) {
  return <PurchasesGate>{children}</PurchasesGate>;
}
