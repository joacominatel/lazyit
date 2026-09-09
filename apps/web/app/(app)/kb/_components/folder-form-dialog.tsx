"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateFolderSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  useCreateArticleCategory,
  useUpdateArticleCategory,
} from "@/lib/api/hooks/use-article-categories";
import { notifyError } from "@/lib/api/notify-error";
import { folderMutationErrorKind } from "@/lib/utils/folder-mutation-error";

/** Only the `name` field — the one thing this dialog collects; the parent comes from the tree row. */
const FormSchema = CreateFolderSchema.pick({ name: true });
type FormValues = { name: string };

const FORM_ID = "kb-folder-form";

/**
 * FolderFormDialog — the KB folder **create** and **rename** dialog (#1291), reached from the folder
 * tree's per-row "⋯" menu and from the rail's "New folder" button. Gated on `category:write` by its
 * triggers; the API enforces.
 *
 * Create seeds `parentId` from the row it was opened on, which is the whole point: the shared
 * `components/create-category-dialog.tsx` quick-create is name-only and always lands a folder at the
 * ROOT, and it is shared with the consumables / applications / assets taxonomies. A KB-owned dialog
 * keeps `parentId` (a Knowledge-Base-only concept) out of that shared surface entirely — see the PR
 * for the reasoning.
 *
 * Error surfacing: the API owns the rules (ADR-0059 §1) and this never re-implements them. A
 * duplicate name within the target parent (409, the per-parent partial-unique index) is classified by
 * {@link folderMutationErrorKind} and shown INLINE on the name field, where the user can fix it;
 * a dead parent (400) becomes a specific toast; anything else falls back to `notifyError`, which
 * carries the server's own message and the request id.
 */
export function FolderFormDialog({
  open,
  onOpenChange,
  mode,
  folderId,
  folderName,
  parentId,
  parentName,
  onCreated,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "rename";
  /** The folder being renamed. Required in `rename` mode, ignored in `create`. */
  folderId?: string;
  /** The current name, prefilled in `rename` mode. */
  folderName?: string;
  /** The parent the new folder is created under. `null` creates a ROOT folder. Create mode only. */
  parentId?: string | null;
  /** The parent's display name, for the "New folder in <name>" title. */
  parentName?: string;
  /** Called with the created folder's id, so the tree can reveal and select it. */
  onCreated?: (createdFolderId: string) => void;
  onRenamed?: () => void;
}) {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const create = useCreateArticleCategory();
  const update = useUpdateArticleCategory();
  const isRename = mode === "rename";
  const isPending = isRename ? update.isPending : create.isPending;

  // The tree mounts this dialog only while it is open, so the initial values ARE the per-open reset:
  // rename starts from the current name, create starts empty, and a reopen never shows a stale name
  // or a stale server-side error.
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: "onTouched",
    defaultValues: { name: isRename ? (folderName ?? "") : "" },
  });

  /** Route a failed write: duplicate name inline on the field, the rest as a specific toast. */
  function handleError(error: unknown) {
    const kind = folderMutationErrorKind(error);
    if (kind === "duplicateName") {
      form.setError("name", {
        type: "server",
        message: t("folders.errors.duplicateName"),
      });
      return;
    }
    if (kind === "deadParent") {
      toast.error(t("folders.errors.deadParent"));
      return;
    }
    notifyError(
      error,
      t(isRename ? "folders.form.renameError" : "folders.form.createError"),
    );
  }

  const onSubmit = form.handleSubmit((values) => {
    if (isRename) {
      if (!folderId) return;
      update.mutate(
        { id: folderId, data: { name: values.name } },
        {
          onSuccess: () => {
            toast.success(t("folders.form.renamed"));
            onOpenChange(false);
            onRenamed?.();
          },
          onError: handleError,
        },
      );
      return;
    }
    create.mutate(
      // `parentId` is OPTIONAL on create (absent = a root folder) — never send an explicit null.
      parentId ? { name: values.name, parentId } : { name: values.name },
      {
        onSuccess: (folder) => {
          toast.success(t("folders.form.created"));
          onOpenChange(false);
          onCreated?.(folder.id);
        },
        onError: handleError,
      },
    );
  });

  const title = isRename
    ? t("folders.form.renameTitle")
    : parentName
      ? t("folders.form.createInTitle", { name: parentName })
      : t("folders.form.createRootTitle");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isRename
              ? t("folders.form.renameDescription")
              : parentName
                ? t("folders.form.createDescription")
                : t("folders.form.createRootDescription")}
          </DialogDescription>
        </DialogHeader>

        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
        >
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="kb-folder-name" required>
                  {t("folders.form.nameLabel")}
                </FieldLabel>
                <Input
                  {...field}
                  id="kb-folder-name"
                  value={field.value ?? ""}
                  placeholder={t("folders.form.namePlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                  autoFocus
                />
                {/* `name` is `min(1).max(100)`; swap the localized copy in for the empty case rather
                    than leaking the raw zod message (same treatment as the shared quick-create). */}
                <FieldError
                  errors={[
                    fieldState.error?.type === "too_small"
                      ? { message: t("folders.form.nameRequired") }
                      : fieldState.error,
                  ]}
                />
              </Field>
            )}
          />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={isPending}>
            {isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {isRename ? t("folders.form.save") : t("folders.form.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
