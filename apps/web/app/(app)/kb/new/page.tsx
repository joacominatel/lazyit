import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ArticleForm } from "../_components/article-form";

export default function NewArticlePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Knowledge Base", href: "/kb" },
              { label: "New" },
            ]}
          />
        }
        title="New article"
        subtitle="Write a draft in Markdown — publish it from the article once it's ready."
      />
      <ArticleForm />
    </div>
  );
}
