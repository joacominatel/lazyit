import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { getArticleCategories } from "@/lib/api/endpoints/article-categories";
import { articleCategoryKeys } from "@/lib/api/hooks/use-article-categories";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { KbShell } from "./_components/kb-shell";

// Server segment: sets the static section title AND seeds the persistent tree route-shell (#1106
// Phase 3). It feeds the root `%s · lazyit` template so this section's tabs read "Knowledge Base ·
// lazyit". A per-entity / per-locale title would need a server `generateMetadata` (deferred, #500).
export const metadata: Metadata = { title: "Knowledge Base" };

/**
 * KB layout — the persistent shell wrapper. App Router layouts do NOT remount on child navigation, so
 * mounting {@link KbShell} here lets its folder tree persist across the browse list and every reading
 * page (Phase 3). It also SERVER-PREFETCHES the folder list (ADR-0067) into a per-request QueryClient
 * and hydrates it, so a COLD deep-link straight to `/kb/<slug>` paints the tree immediately rather than
 * flashing an empty rail (the page-level article/list prefetch nests inside `children`, untouched).
 */
export default async function KbLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: articleCategoryKeys.lists(),
    queryFn: () => getArticleCategories(session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <KbShell>{children}</KbShell>
    </HydrationBoundary>
  );
}
