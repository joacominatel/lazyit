import type { Metadata } from "next";
import { SettingsShell } from "./_components/settings-shell";

// Server segment that sets the static section title and the Settings frame. The title feeds the root
// `%s · lazyit` template (app/layout.tsx) so this section's tabs read "Settings · lazyit" instead of
// the bare default; the pages below are mostly Client Components and cannot export metadata
// themselves. A per-entity / per-locale title would need a server `generateMetadata` and is deferred
// to the SSR work (#500). The frame — the grouped side nav (#1533) — is a client island, so this
// segment stays a Server Component and every page keeps its own server prefetch.
export const metadata: Metadata = { title: "Settings" };

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SettingsShell>{children}</SettingsShell>;
}
