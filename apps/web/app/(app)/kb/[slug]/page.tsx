import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getArticleBySlug } from "@/lib/api/endpoints/articles";
import { articleKeys } from "@/lib/api/hooks/use-articles";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ArticleDetailView } from "./_components/article-detail-view";

/**
 * Article detail — an ADR-0067 server-prefetch route. This thin Server Component prefetches the
 * by-slug article into a per-request `QueryClient`, dehydrates it, and hydrates the client
 * `ArticleDetailView`. The prefetched key (`articleKeys.bySlug(slug)`) must be byte-identical to
 * the one the child's `useArticleBySlug(slug)` builds, or the dehydrated entry misses and the
 * client refetches (double-fetch). See the assets page for the full rationale; the #600 401 handler
 * stays on the client provider.
 */
export default async function ArticleDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: articleKeys.bySlug(slug),
    queryFn: () => getArticleBySlug(slug, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ArticleDetailView slug={slug} />
    </HydrationBoundary>
  );
}
