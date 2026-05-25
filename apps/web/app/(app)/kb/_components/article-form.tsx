"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Article,
  CreateArticleSchema,
  UpdateArticleSchema,
} from "@lazyit/shared";
import { useRouter } from "next/navigation";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useActingUserId } from "@/lib/api/acting-user";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import {
  useCreateArticle,
  useUpdateArticle,
} from "@/lib/api/hooks/use-article-mutations";

const FORM_ID = "article-form";

type ArticleFormValues = {
  title: string;
  categoryId: string;
  excerpt?: string;
  content: string;
};

function toFormValues(article?: Article): ArticleFormValues {
  if (article) {
    return {
      title: article.title,
      categoryId: article.categoryId,
      excerpt: article.excerpt ?? undefined,
      content: article.content,
    };
  }
  return { title: "", categoryId: "", excerpt: undefined, content: "" };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Full-page create/edit form for a KB Article. Like the User dialog it validates
 * against different shared schemas per mode (CreateArticleSchema vs the partial
 * UpdateArticleSchema — see ADR-0020); create is invoked on /kb/new, edit on a
 * separate route, so each mounts fresh and the resolver is fixed. `status` is not
 * edited here — new articles are born DRAFT and publishing is a detail-view
 * action (ADR-0021). `slug` is auto-derived from the title by the API.
 */
export function ArticleForm({ article }: { article?: Article }) {
  const isEdit = article != null;
  const router = useRouter();
  const { data: categories } = useArticleCategories();
  const actingUserId = useActingUserId();
  const createArticle = useCreateArticle();
  const updateArticle = useUpdateArticle();
  const isPending = createArticle.isPending || updateArticle.isPending;

  const form = useForm<ArticleFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateArticleSchema : CreateArticleSchema,
    ) as Resolver<ArticleFormValues>,
    defaultValues: toFormValues(article),
  });

  const onSubmit = form.handleSubmit((values) => {
    if (!actingUserId) {
      toast.error("Pick a user in the top-right switcher to author articles");
      return;
    }
    if (article) {
      updateArticle.mutate(
        {
          id: article.id,
          data: {
            title: values.title,
            categoryId: values.categoryId,
            content: values.content,
            excerpt: values.excerpt,
          },
        },
        {
          onSuccess: (updated) => {
            toast.success("Article saved");
            router.push(`/kb/${updated.slug}`);
          },
          onError: (error) =>
            toast.error(errorMessage(error, "Couldn't save the article")),
        },
      );
    } else {
      createArticle.mutate(
        {
          title: values.title,
          categoryId: values.categoryId,
          content: values.content,
          status: "DRAFT",
          ...(values.excerpt ? { excerpt: values.excerpt } : {}),
        },
        {
          onSuccess: (created) => {
            toast.success("Draft created");
            router.push(`/kb/${created.slug}`);
          },
          onError: (error) =>
            toast.error(errorMessage(error, "Couldn't create the article")),
        },
      );
    }
  });

  const hasCategories = (categories?.length ?? 0) > 0;

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
      {!actingUserId && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          You&apos;re browsing anonymously. Pick a user in the top-right switcher
          to author articles.
        </p>
      )}
      <FieldGroup>
        <Controller
          control={form.control}
          name="title"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="title">Title</FieldLabel>
              <Input
                {...field}
                id="title"
                value={field.value ?? ""}
                placeholder="How to set up the office VPN"
                aria-invalid={fieldState.invalid || undefined}
                autoFocus
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="categoryId"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="categoryId">Category</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  id="categoryId"
                  className="w-full sm:w-72"
                  aria-invalid={fieldState.invalid || undefined}
                >
                  <SelectValue
                    placeholder={
                      hasCategories ? "Select a category" : "No categories yet"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(categories ?? []).map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!hasCategories && (
                <FieldDescription>
                  Categories are managed via the API/seed for now.
                </FieldDescription>
              )}
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="excerpt"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="excerpt">Excerpt</FieldLabel>
              <Input
                id="excerpt"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                placeholder="A one-line summary shown in listings (optional)"
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="content"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="content">Content</FieldLabel>
              <MarkdownEditor
                id="content"
                value={field.value ?? ""}
                onChange={field.onChange}
                invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            router.push(article ? `/kb/${article.slug}` : "/kb")
          }
        >
          Cancel
        </Button>
        <Button
          type="submit"
          form={FORM_ID}
          disabled={isPending || !actingUserId}
        >
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? "Save changes" : "Create draft"}
        </Button>
      </div>
    </form>
  );
}
