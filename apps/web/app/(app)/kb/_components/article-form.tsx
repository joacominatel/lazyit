"use client";

import { ArrowPathIcon, ArrowUturnLeftIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Article,
  CreateArticleSchema,
  UpdateArticleSchema,
} from "@lazyit/shared";
import { useFormatter, useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { CreatableField } from "@/components/creatable-field";
import { CreateCategoryDialog } from "@/components/create-category-dialog";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useArticleSlugSuggestions } from "@/lib/api/hooks/use-article-slug-suggestions";
import { useHandleSuggestions } from "@/lib/secret-manager/hooks/use-chip";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { ApiError } from "@/lib/api/client";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import {
  useCreateArticle,
  useUpdateArticle,
} from "@/lib/api/hooks/use-article-mutations";
import { useUploadAttachment } from "@/lib/api/hooks/use-attachments";
import { notifyError } from "@/lib/api/notify-error";
import { useBeforeUnloadGuard } from "@/lib/hooks/use-before-unload-guard";
import { useCan } from "@/lib/hooks/use-permissions";
import type { MarkdownImport } from "@/lib/utils/kb-markdown-import";
import type { KbNewPrefill } from "@/lib/utils/kb-wiki-link-prefill";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import { useArticleDraft } from "../_lib/use-article-draft";
import { MarkdownImportDropzone } from "./markdown-import-dropzone";

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
 *
 * `prefill` (#1106 Phase 4) seeds a CREATE form from a create-on-click on an unresolved `[[slug]]`:
 * the sanitized `title` seeds the title field and the sanitized `slug` is sent on create so the new
 * note takes exactly the wiki-link's target slug (resolving the original red link). Both are already
 * validated by `parseKbNewPrefill` at the page edge; ignored entirely on edit.
 */
export function ArticleForm({
  article,
  prefill,
}: {
  article?: Article;
  prefill?: KbNewPrefill;
}) {
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
  // Gated on `secret:read` (issue #942 — the underlying `/secret-manager/items/handles` endpoint
  // requires it) so a MEMBER without the permission never fires this prefetch and never eats a 403
  // on every mount; the chip itself simply offers no suggestions for them.
  const canReadSecrets = useCan("secret:read");
  const [chipQuery, setChipQuery] = useState<string | undefined>(undefined);
  const wikiLinkSuggestions = useArticleSlugSuggestions(wikiLinkQuery);
  const { data: chipSuggestions } = useHandleSuggestions(
    chipQuery,
    canReadSecrets,
  );

  // KB inline-image upload (ADR-0082 §5): paste/drop/pick uploads a raster image onto THIS article
  // and inserts an `attachment:<id>` ref. Only wired on an existing article — a brand-new draft has
  // no id yet, so `upload` stays undefined and the editor shows a "save the draft first" hint. The
  // hook is called unconditionally (rules of hooks) with the id when present.
  const uploadImage = useUploadAttachment("article", article?.id ?? "");

  const format = useFormatter();
  const baseline = useMemo(() => {
    const values = toFormValues(article);
    // #1106 Phase 4: seed a CREATE form's title from the sanitized wiki-link prefill (never on edit).
    if (!article && prefill?.title) values.title = prefill.title;
    return values;
  }, [article, prefill]);

  const form = useForm<ArticleFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateArticleSchema : CreateArticleSchema,
    ) as Resolver<ArticleFormValues>,
    defaultValues: baseline,
  });

  // ── Unsaved-work protection (issue #816) ─────────────────────────────────────────────────────
  // 1) Hard navigations (tab close / reload / address bar) get the native confirm while dirty.
  // 2) The Cancel button intercepts in-app navigation with a confirm while dirty.
  // 3) A local, slug-keyed draft is autosaved and offered for restore on the next mount, then
  //    cleared on a successful save — so a crash/closed tab never silently discards a runbook.
  const { isDirty } = form.formState;
  useBeforeUnloadGuard(isDirty);

  const draft = useArticleDraft(article?.slug, baseline);
  const queueSave = draft.queueSave;
  // Subscribe to value changes WITHOUT re-rendering (the hook throttles the localStorage write).
  useEffect(() => {
    const unsubscribe = form.subscribe({
      formState: { values: true },
      callback: ({ values }) =>
        queueSave({
          title: values.title ?? "",
          categoryId: values.categoryId ?? "",
          excerpt: values.excerpt,
          content: values.content ?? "",
        }),
    });
    return () => unsubscribe();
  }, [form, queueSave]);

  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const cancelHref = article ? `/kb/${article.slug}` : "/kb";

  const handleRestoreDraft = () => {
    const values = draft.restorable?.values;
    if (!values) return;
    // keepDefaultValues re-evaluates isDirty against the original server/empty baseline, so the
    // restored draft stays guarded + autosaved rather than being treated as pristine.
    form.reset(values, { keepDefaultValues: true });
    draft.dismissRestore();
  };

  const handleDiscardDraft = () => {
    draft.clearDraft();
    draft.dismissRestore();
  };

  const handleCancel = () => {
    if (isDirty) {
      setLeaveConfirmOpen(true);
      return;
    }
    router.push(cancelHref);
  };

  const confirmLeave = () => {
    // Explicit discard: drop the local draft too so it never resurfaces as a stale restore prompt.
    draft.clearDraft();
    setLeaveConfirmOpen(false);
    router.push(cancelHref);
  };

  // ── Drag-and-drop markdown import (#1106, CREATE only) ───────────────────────────────────────
  // A dropped/picked .md fills the editor client-side (never uploaded). Its content lands in the
  // `content` field; the derived title fills `title` ONLY when the user hasn't typed one. If the
  // editor already has content we confirm before replacing it rather than silently clobbering.
  const [pendingImport, setPendingImport] = useState<MarkdownImport | null>(null);

  const applyImport = (result: MarkdownImport) => {
    form.setValue("content", result.content, {
      shouldDirty: true,
      shouldValidate: true,
    });
    if (result.title && !form.getValues("title")?.trim()) {
      form.setValue("title", result.title, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
    toast.success(t("mdImport.toast.imported"));
  };

  const handleImport = (result: MarkdownImport) => {
    // Non-empty typed content → confirm before replacing; empty → fill straight away.
    if (form.getValues("content")?.trim()) {
      setPendingImport(result);
      return;
    }
    applyImport(result);
  };

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
            // Clear the dirty flag FIRST (issue #942): a saved form must never trip the
            // beforeunload/leave-confirm guard, even for however brief a window the in-app
            // navigation below takes.
            form.reset(values);
            draft.clearDraft();
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
          // #1106 Phase 4: when created from a wiki-link, take the link's exact (validated) target
          // slug so the note resolves the original `[[slug]]`. Used as-is (no auto-suffix) — a slug
          // already taken by a live row surfaces as a 409, mapped to a specific message in onError.
          ...(prefill?.slug ? { slug: prefill.slug } : {}),
        },
        {
          onSuccess: (created) => {
            // Clear the dirty flag FIRST (issue #942): a successful "Create draft" must never
            // leave the form looking unsaved, or trip beforeunload, during the navigation below.
            form.reset(values);
            draft.clearDraft();
            toast.success(t("form.toast.draftCreated"));
            router.push(`/kb/${created.slug}`);
          },
          onError: (error) => {
            // A create 409 means the slug is already taken by a live article (the only unique
            // constraint at create) — including a wiki-link target the author couldn't see (a
            // >200-item KB, another author's draft, a folder-hidden row). The link can't be resolved
            // by creating a new note under a taken slug, so say so specifically (#1106).
            if (error instanceof ApiError && error.status === 409) {
              toast.error(t("form.toast.slugTaken"));
              return;
            }
            notifyError(error, t("form.toast.createError"));
          },
        },
      );
    }
  }, (_errors, event) => scrollToFirstError(event?.target ?? null));

  const hasCategories = (categories?.length ?? 0) > 0;

  const formBody = (
    <>
      {draft.restorable && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2">
            <ArrowUturnLeftIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
              <p className="font-medium text-foreground">
                {t("form.draft.restoreTitle")}
              </p>
              <p className="text-muted-foreground">
                {t("form.draft.restoreDescription", {
                  time: format.dateTime(new Date(draft.restorable.savedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDiscardDraft}
            >
              {t("form.draft.discard")}
            </Button>
            <Button type="button" size="sm" onClick={handleRestoreDraft}>
              {t("form.draft.restore")}
            </Button>
          </div>
        </div>
      )}

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
              {/* `title` is `min(1).max(200)`; only the empty case is common in practice (a runaway
                  paste past 200 chars is rare and stays as the raw zod message) — swap in the
                  localized copy for the required case rather than leak it untranslated (issue #966,
                  same class as the `categoryId` fix below). */}
              <FieldError
                errors={[
                  fieldState.error?.type === "too_small"
                    ? { message: t("form.titleRequired") }
                    : fieldState.error,
                ]}
              />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="categoryId"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="categoryId" required>
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
              {/* `categoryId` only ever fails its schema's `z.cuid()` check (an empty/unselected
                  value), so the raw zod message ("Invalid cuid") is always the required case here —
                  swap in the localized copy rather than leak it untranslated (issue #942). */}
              <FieldError
                errors={[
                  fieldState.error && { message: t("form.categoryRequired") },
                ]}
              />
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
                image={{
                  articleId: article?.id,
                  upload: article
                    ? (file) => uploadImage.mutateAsync(file)
                    : undefined,
                }}
              />
              {/* `content` is `min(1)` (no upper bound) — its only failure mode is empty, so swap in
                  the localized copy unconditionally (issue #966, same class as `title` above). */}
              <FieldError
                errors={[
                  fieldState.error && { message: t("form.contentRequired") },
                ]}
              />
            </Field>
          )}
        />
      </FieldGroup>
    </>
  );

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
      {/* #1106: drag-and-drop markdown import is a CREATE-only affordance. On edit the editor owns
          image drag/drop, so the body renders plain. */}
      {isEdit ? (
        formBody
      ) : (
        <MarkdownImportDropzone onImport={handleImport}>
          <div className="space-y-6">{formBody}</div>
        </MarkdownImportDropzone>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={handleCancel}
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

      <AlertDialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("form.leaveConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("form.leaveConfirm.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("form.leaveConfirm.stay")}</AlertDialogCancel>
            {/* Plain destructive button (not AlertDialogAction) so leaving is an explicit,
                clearly-styled discard rather than the default confirm. */}
            <Button variant="destructive" onClick={confirmLeave}>
              {t("form.leaveConfirm.leave")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* #1106: importing a .md over already-typed content asks first (never a silent clobber). */}
      <AlertDialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mdImport.replaceConfirm.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mdImport.replaceConfirm.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("mdImport.replaceConfirm.cancel")}
            </AlertDialogCancel>
            {/* Plain destructive button (not AlertDialogAction) so replacing typed content is an
                explicit, clearly-styled discard — mirrors the leave-confirm above. */}
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingImport) applyImport(pendingImport);
                setPendingImport(null);
              }}
            >
              {t("mdImport.replaceConfirm.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
