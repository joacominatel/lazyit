"use client";

import dynamic from "next/dynamic";

/**
 * /secrets — the vault list (ADR-0061 §7). A thin client shell whose ONLY job is the `ssr:false`
 * boundary: the content (which transitively pulls `crypto.ts` / `argon2.ts` / the Argon2id wasm in via
 * the unlock gate) is loaded client-only, so the crypto graph never enters the server/RSC bundle (the
 * #366 spike's ratified recipe; confirmed by `next build`). The session provider is the `/secrets`
 * layout; the page just renders inside it.
 */
const VaultListContent = dynamic(() => import("./_components/vault-list-content"), {
  ssr: false,
  loading: () => <VaultListFallback />,
});

export default function SecretsPage() {
  return <VaultListContent />;
}

/** Minimal pre-hydration shell — a soft pulse where the list will render. */
function VaultListFallback() {
  return (
    <div className="space-y-6">
      <div className="h-9 w-48 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {["a", "b", "c"].map((key) => (
          <div key={key} className="h-28 animate-pulse rounded-xl bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
