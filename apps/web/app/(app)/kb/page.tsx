import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { type ArticleFilters, getArticles } from "@/lib/api/endpoints/articles";
import { articleKeys } from "@/lib/api/hooks/use-articles";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ArticlesListView } from "./_components/articles-list-view";

/**
 * Knowledge Base list — an ADR-0067 server-prefetch route. This thin Server Component prefetches
 * the FIRST-PAINT (unfiltered) article page into a per-request `QueryClient`, dehydrates it, and
 * hydrates the client `ArticlesListView`.
 *
 * The prefetched query key MUST be byte-identical to the one the child's `useArticles(filters)`
 * builds on a fresh load with no URL params — otherwise the dehydrated entry won't hit and the
 * client would refetch (double-fetch). `ArticlesListView` derives its filters from `useListParams`
 * (limit 50, offset 0) and maps every empty multi-select / inactive toggle to `undefined`, so a
 * no-param load yields exactly {@link DEFAULT_FILTERS} below. Any URL with filters/paging is NOT
 * prefetched here — it simply misses the cache and the client fetches it (the correct degraded path
 * for a lower-frequency case). The #600 401 handler stays on the client provider, untouched.
 */
const DEFAULT_FILTERS: ArticleFilters = {
  q: undefined,
  status: undefined,
  categoryId: undefined,
  linked: undefined,
  linkedTo: undefined,
  assetId: undefined,
  applicationId: undefined,
  limit: 50,
  offset: 0,
};

export default async function KnowledgeBasePage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: articleKeys.list(DEFAULT_FILTERS),
    queryFn: () => getArticles(DEFAULT_FILTERS, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ArticlesListView />
    </HydrationBoundary>
  );
}
