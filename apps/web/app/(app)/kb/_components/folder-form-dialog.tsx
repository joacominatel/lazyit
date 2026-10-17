"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  CreateFolderSchema,
  type CreateFolder,
  type Folder,
  type UpdateFolder,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Controller, useForm, useWatch } from "react-hook-form";
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateArticleCategory,
  useUpdateArticleCategory,
} from "@/lib/api/hooks/use-article-categories";
import { notifyError } from "@/lib/api/notify-error";
import { folderMutationErrorKind } from "@/lib/utils/folder-mutation-error";

/** The form keeps every field as text; `order` is parsed on submit. */
type FormValues = { name: string; description: string; order: string };

const FORM_ID = "kb-folder-form";

/** The shared field rules (CreateArticleCategorySchema) — the dialog validates against them, never a copy. */
const NAME_RULE = CreateFolderSchema.shape.name;
const DESCRIPTION_RULE = CreateFolderSchema.shape.description;
const ORDER_RULE = CreateFolderSchema.shape.order;
const INTEGER = /^-?\d+$/;

/**
 * FolderFormDialog — create a KB folder, or edit one (#1291, #1539). Reached from the rail's "+", a
 * folder row's "⋯", the folder header's "Subfolder" and "⋯ → Edit", and the home page's "New folder"
 * card. Gated on `category:write` by its triggers; the API enforces.
 *
 * - **Create** takes a name and an optional description; `parentId` comes from where it was opened
 *   (`null` = a root folder). Nesting is a Knowledge-Base-only concept, so this stays a KB-owned
 *   dialog rather than the shared name-only quick-create.
 * - **Edit** takes name, description and the optional `order` sort key (lower first; empty = after the
 *   ordered ones). It replaces the Settings → Taxonomies folder manager. Only changed fields are sent.
 *   The update contract cannot clear a description or an order once set (both are non-null there), so
 *   emptying one says so instead of pretending to save it.
 *
 * Error surfacing: the API owns the rules (ADR-0059 §1). A duplicate name within the parent (409) is
 * shown INLINE on the name field; a dead parent (400) is a specific toast; anything else falls back to
 * `notifyError`, which carries the server's own message and the request id.
 */
export function FolderFormDialog(
  props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  } & (
    | {
        mode: "create";
        /** The parent the new folder is created under. `null` creates a ROOT folder. */
        parentId: string | null;
        /** The parent's display name, for the "New folder in <name>" title. */
        parentName?: string;
        /** Called with the created folder's id, so the caller can reveal and open it. */
        onCreated?: (createdFolderId: string) => void;
      }
    | {
        mode: "edit";
        folder: Pick<Folder, "id" | "name" | "description" | "order">;
      }
  ),
) {
  const { open, onOpenChange } = props;
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const create = useCreateArticleCategory();
  const update = useUpdateArticleCategory();
  const isEdit = props.mode === "edit";
  const original = isEdit ? props.folder : null;
  const isPending = isEdit ? update.isPending : create.isPending;

  // Callers mount this dialog only while it is open, so the initial values ARE the per-open reset.
  const form = useForm<FormValues>({
    mode: "onTouched",
    defaultValues: {
      name: original?.name ?? "",
      description: original?.description ?? "",
      order: original?.order != null ? String(original.order) : "",
    },
  });

  const description = useWatch({ control: form.control, name: "description" });
  const order = useWatch({ control: form.control, name: "order" });
  const clearsDescription = Boolean(original?.description) && description.trim() === "";
  const clearsOrder = original?.order != null && order.trim() === "";

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
      t(isEdit ? "folders.form.editError" : "folders.form.createError"),
    );
  }

  const onSubmit = form.handleSubmit((values) => {
    const name = values.name.trim();
    const desc = values.description.trim();
    const orderText = values.order.trim();

    if (props.mode === "edit") {
      const data: UpdateFolder = {};
      if (name !== props.folder.name) data.name = name;
      if (desc && desc !== (props.folder.description ?? "")) data.description = desc;
      if (orderText && Number(orderText) !== props.folder.order) data.order = Number(orderText);
      if (Object.keys(data).length === 0) {
        onOpenChange(false);
        return;
      }
      update.mutate(
        { id: props.folder.id, data },
        {
          onSuccess: () => {
            toast.success(t("folders.form.saved"));
            onOpenChange(false);
          },
          onError: handleError,
        },
      );
      return;
    }

    // `parentId` and `description` are OPTIONAL on create — never send an explicit null or "".
    const payload: CreateFolder = { name };
    if (props.parentId) payload.parentId = props.parentId;
    if (desc) payload.description = desc;
    const { onCreated } = props;
    create.mutate(payload, {
      onSuccess: (folder) => {
        toast.success(t("folders.form.created"));
        onOpenChange(false);
        onCreated?.(folder.id);
      },
      onError: handleError,
    });
  });

  const title = isEdit
    ? t("folders.form.editTitle")
    : props.parentName
      ? t("folders.form.createInTitle", { name: props.parentName })
      : t("folders.form.createRootTitle");

  const subtitle = isEdit
    ? t("folders.form.editDescription")
    : props.parentName
      ? t("folders.form.createDescription")
      : t("folders.form.createRootDescription");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
          className="space-y-4"
        >
          <Controller
            control={form.control}
            name="name"
            rules={{
              validate: (value) =>
                NAME_RULE.safeParse(value).success ||
                t("folders.form.nameRequired"),
            }}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="kb-folder-name" required>
                  {t("folders.form.nameLabel")}
                </FieldLabel>
                <Input
                  {...field}
                  id="kb-folder-name"
                  placeholder={t("folders.form.namePlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                  maxLength={100}
                  autoFocus
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="description"
            rules={{
              validate: (value) =>
                value.trim() === "" ||
                DESCRIPTION_RULE.safeParse(value).success ||
                t("folders.form.descriptionTooLong"),
            }}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="kb-folder-description">
                  {t("folders.form.descriptionLabel")}
                </FieldLabel>
                <Textarea
                  {...field}
                  id="kb-folder-description"
                  rows={3}
                  maxLength={1000}
                  placeholder={t("folders.form.descriptionPlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                {clearsDescription ? (
                  <FieldDescription>
                    {t("folders.form.cannotClear")}
                  </FieldDescription>
                ) : null}
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          {isEdit ? (
            <Controller
              control={form.control}
              name="order"
              rules={{
                validate: (value) => {
                  const text = value.trim();
                  if (text === "") return true;
                  return (
                    (INTEGER.test(text) &&
                      ORDER_RULE.safeParse(Number(text)).success) ||
                    t("folders.form.orderInvalid")
                  );
                },
              }}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="kb-folder-order">
                    {t("folders.form.orderLabel")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="kb-folder-order"
                    inputMode="numeric"
                    className="w-32 font-mono tabular-nums"
                    placeholder="0"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldDescription>
                    {clearsOrder
                      ? t("folders.form.cannotClear")
                      : t("folders.form.orderHint")}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          ) : null}
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
            {isEdit ? t("folders.form.save") : t("folders.form.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
