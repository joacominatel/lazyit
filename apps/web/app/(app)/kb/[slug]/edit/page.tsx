"use client";

import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import { ArticleForm } from "../../_components/article-form";

export default function EditArticlePage() {
  const params = useParams<{ slug: string }>();
  const { data: article, isLoading, isError } = useArticleBySlug(params.slug);
  const { data: session } = useSession();

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (isError || !article) {
    return (
      <NotEditable
        title="Article not found"
        description="It may be a draft you can't see, or it was deleted."
        slug={params.slug}
        backToList
      />
    );
  }

  if (!session) {
    return (
      <NotEditable
        title="Not signed in"
        description="You must be signed in to edit articles."
        slug={article.slug}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit article</h1>
        <p className="text-sm text-muted-foreground">
          Changes don&apos;t alter the published/draft state — use Publish on the
          article for that.
        </p>
      </div>
      <ArticleForm article={article} />
    </div>
  );
}

function NotEditable({
  title,
  description,
  slug,
  backToList = false,
}: {
  title: string;
  description: string;
  slug: string;
  backToList?: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
      <Button variant="outline" asChild>
        <Link href={backToList ? "/kb" : `/kb/${slug}`}>
          <ArrowLeftIcon />
          {backToList ? "Back to Knowledge Base" : "Back to the article"}
        </Link>
      </Button>
    </div>
  );
}
