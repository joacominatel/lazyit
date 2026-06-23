import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getArticleBySlug } from "@/lib/api/endpoints/articles";
import { articleKeys } from "@/lib/api/hooks/use-articles";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ArticleEditView } from "./_components/article-edit-view";

/**
 * Article edit — an ADR-0067 server-prefetch route. Like the detail route, the form's primary read
 * is `useArticleBySlug(slug)`, so this thin Server Component prefetches `articleKeys.bySlug(slug)`
 * into a per-request `QueryClient`, dehydrates it, and hydrates the client `ArticleEditView`. The
 * key must be byte-identical to the child's, or the dehydrated entry misses and the client refetches
 * (double-fetch). See the assets page for the full rationale; the #600 401 handler stays on the
 * client provider.
 */
export default async function EditArticlePage({
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
      <ArticleEditView slug={slug} />
    </HydrationBoundary>
  );
}
