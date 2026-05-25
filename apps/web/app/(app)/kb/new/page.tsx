import { ArticleForm } from "../_components/article-form";

export default function NewArticlePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New article</h1>
        <p className="text-sm text-muted-foreground">
          Write a draft in Markdown — publish it from the article once it&apos;s
          ready.
        </p>
      </div>
      <ArticleForm />
    </div>
  );
}
