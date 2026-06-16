"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Article,
  CreateArticleSchema,
  UpdateArticleSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { CreatableField } from "@/components/creatable-field";
import { CreateCategoryDialog } from "@/components/create-category-dialog";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useArticleSlugSuggestions } from "@/lib/api/hooks/use-article-slug-suggestions";
import { useHandleSuggestions } from "@/lib/secret-manager/hooks/use-chip";
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
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import {
  useCreateArticle,
  useUpdateArticle,
} from "@/lib/api/hooks/use-article-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

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

/**
 * Full-page create/edit form for a KB Article. Like the User dialog it validates
 * against different shared schemas per mode (CreateArticleSchema vs the partial
 * UpdateArticleSchema — see ADR-0020); create is invoked on /kb/new, edit on a
 * separate route, so each mounts fresh and the resolver is fixed. `status` is not
 * edited here — new articles are born DRAFT and publishing is a detail-view
 * action (ADR-0021). `slug` is auto-derived from the title by the API.
 *
 * Authorship is enforced server-side via the OIDC Bearer token (ADR-0038/0039).
 */
export function ArticleForm({ article }: { article?: Article }) {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const isEdit = article != null;
  const router = useRouter();
  const { data: session } = useSession();
  const { data: categories } = useArticleCategories();
  const createArticle = useCreateArticle();
  const updateArticle = useUpdateArticle();
  const isPending = createArticle.isPending || updateArticle.isPending;
  const isAuthenticated = session != null;

  // `[[slug]]` autocomplete (ADR-0059 §3): the editor reports the open-token query, we search existing
  // articles for matching slugs and feed the suggestions back. Reuses the standard article search —
  // there is no dedicated slug-search endpoint (see the issue findings).
  const [wikiLinkQuery, setWikiLinkQuery] = useState("");

  // `{{ lazyit_secret.HANDLE }}` chip autocomplete (ADR-0061 §8): the editor reports the partial handle,
  // we fetch matching handles (metadata only — never values) from the backend, scoped to the author's
  // vault memberships. Omit if the author has no memberships (the query returns [] gracefully).
  const [chipQuery, setChipQuery] = useState<string | undefined>(undefined);
  const wikiLinkSuggestions = useArticleSlugSuggestions(wikiLinkQuery);
  const { data: chipSuggestions } = useHandleSuggestions(chipQuery);

  const form = useForm<ArticleFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateArticleSchema : CreateArticleSchema,
    ) as Resolver<ArticleFormValues>,
    defaultValues: toFormValues(article),
  });

  const onSubmit = form.handleSubmit((values) => {
    if (!isAuthenticated) {
      toast.error(t("form.toast.signInRequired"));
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
            toast.success(t("form.toast.saved"));
            router.push(`/kb/${updated.slug}`);
          },
          onError: (error) =>
            notifyError(error, t("form.toast.saveError")),
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
            toast.success(t("form.toast.draftCreated"));
            router.push(`/kb/${created.slug}`);
          },
          onError: (error) =>
            notifyError(error, t("form.toast.createError")),
        },
      );
    }
  }, (_errors, event) => scrollToFirstError(event?.target ?? null));

  const hasCategories = (categories?.length ?? 0) > 0;

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
      <FieldGroup>
        <Controller
          control={form.control}
          name="title"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="title">{t("form.titleLabel")}</FieldLabel>
              <Input
                {...field}
                id="title"
                value={field.value ?? ""}
                placeholder={t("form.titlePlaceholder")}
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
              <FieldLabel htmlFor="categoryId">
                {t("form.categoryLabel")}
              </FieldLabel>
              <CreatableField
                entityKey="category"
                renderDialog={(dialog) => (
                  <CreateCategoryDialog
                    kind="article"
                    open={dialog.open}
                    onOpenChange={dialog.onOpenChange}
                    onCreated={(category) => field.onChange(category.id)}
                  />
                )}
              >
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    id="categoryId"
                    className="w-full sm:w-72"
                    aria-invalid={fieldState.invalid || undefined}
                  >
                    <SelectValue
                      placeholder={
                        hasCategories
                          ? t("form.categorySelect")
                          : t("form.categoryNone")
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
              </CreatableField>
              {!hasCategories && (
                <FieldDescription>{t("form.categoryHint")}</FieldDescription>
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
              <FieldLabel htmlFor="excerpt">{t("form.excerptLabel")}</FieldLabel>
              <Input
                id="excerpt"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                placeholder={t("form.excerptPlaceholder")}
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
              <FieldLabel htmlFor="content">{t("form.contentLabel")}</FieldLabel>
              <MarkdownEditor
                id="content"
                value={field.value ?? ""}
                onChange={field.onChange}
                invalid={fieldState.invalid}
                wikiLink={{
                  onQueryChange: setWikiLinkQuery,
                  suggestions: wikiLinkSuggestions,
                }}
                secretChip={{
                  onQueryChange: (q) => setChipQuery(q || undefined),
                  suggestions: chipSuggestions ?? [],
                }}
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
          {tc("cancel")}
        </Button>
        <Button
          type="submit"
          form={FORM_ID}
          disabled={isPending || !isAuthenticated}
        >
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? t("form.saveChanges") : t("form.createDraft")}
        </Button>
      </div>
    </form>
  );
}
