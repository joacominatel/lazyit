import type { Metadata } from "next";

// Server segment whose sole job is a static section title. It feeds the root
// `%s · lazyit` template (app/layout.tsx) so this section's tabs read
// "Consumables · lazyit" instead of the bare default. The page below is a Client
// Component and cannot export metadata itself, hence this thin pass-through.
// A per-entity / per-locale title would need a server `generateMetadata` and is
// deferred to the SSR work (#500).
export const metadata: Metadata = { title: "Consumables" };

export default function ConsumablesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
