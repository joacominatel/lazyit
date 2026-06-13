"use client";

import dynamic from "next/dynamic";
import { use } from "react";

/**
 * /secrets/[vaultId] — the vault detail (items + members) — ADR-0061 §3/§6. A thin client shell that
 * unwraps the route param and crosses the `ssr:false` boundary: the detail content pulls the whole
 * crypto read chain (unlock → unwrap DEK → open item) in via the unlock gate + reveal/grant flows, so
 * it must stay client-only (never in the server/RSC bundle). The session provider is the `/secrets`
 * layout above this.
 */
const VaultDetailContent = dynamic(
  () => import("../_components/vault-detail-content"),
  {
    ssr: false,
    loading: () => <VaultDetailFallback />,
  },
);

export default function VaultDetailPage({
  params,
}: {
  params: Promise<{ vaultId: string }>;
}) {
  // Next 16: route params are a Promise; unwrap with `use()` in this Client Component.
  const { vaultId } = use(params);
  return <VaultDetailContent vaultId={vaultId} />;
}

/** Minimal pre-hydration shell for the detail route. */
function VaultDetailFallback() {
  return (
    <div className="space-y-6">
      <div className="h-9 w-64 animate-pulse rounded bg-muted" />
      <div className="h-48 animate-pulse rounded-xl bg-muted/50" />
    </div>
  );
}
