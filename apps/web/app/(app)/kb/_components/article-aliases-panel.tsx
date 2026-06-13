"use client";

import {
  ArrowPathIcon,
  FolderIcon,
  LinkIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ArticleAlias, Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
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
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import {
  useArticleAliases,
  useCreateArticleAlias,
  useDeleteArticleAlias,
} from "@/lib/api/hooks/use-article-wiki-links";
import { notifyError } from "@/lib/api/notify-error";
import { folderPathLabel } from "@/lib/utils/folder-tree";

/**
 * "Also in" — the nav-only ALIAS affordance on the KB article detail (ADR-0059 §2). An article has
 * exactly one HOME folder (its `categoryId`); an alias is a Unix-style symlink that makes it also
 * APPEAR in another folder for browsing, WITHOUT moving its home or widening access (access is
 * ADR-0060's job, not built here — there is no padlock/restricted UI).
 *
 * Lists the article's aliases (resolving each `folderId` to its folder name/path from the folder
 * list), and — when the caller can write — offers an inline "Add to folder…" picker (the home folder
 * and already-aliased folders are excluded) and per-row removal (hard delete). The API enforces
 * author-only + the "not the home folder" + "no duplicate" rules; this UI mirrors them for a clean UX.
 */
export function ArticleAliasesPanel({
  articleId,
  homeFolderId,
  canWrite,
}: {
  articleId: string;
  /** The article's home folder (`categoryId`) — never an alias target (rejected by the API). */
  homeFolderId: string;
  canWrite: boolean;
}) {
  const t = useTranslations("kb");
  const { data: aliases, isLoading } = useArticleAliases(articleId);
  const { data: folders } = useArticleCategories();
  const removeAlias = useDeleteArticleAlias();

  const [addOpen, setAddOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const folderById = useMemo(
    () => new Map((folders ?? []).map((f) => [f.id, f])),
    [folders],
  );

  const rows = aliases ?? [];

  function handleRemove(alias: ArticleAlias) {
    setRemovingId(alias.id);
    removeAlias.mutate(
      { articleId, aliasId: alias.id },
      {
        onSuccess: () => {
          toast.success(t("aliases.toast.removed"));
          setRemovingId(null);
        },
        onError: (error) => {
          notifyError(error, t("aliases.toast.removeError"));
          setRemovingId(null);
        },
      },
    );
  }

  return (
    <DetailPanel
      title={t("aliases.panelTitle")}
      actions={
        canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            {t("aliases.add")}
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("aliases.loading")}</p>
      ) : rows.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <LinkIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{t("aliases.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((alias) => {
            const folder = folderById.get(alias.folderId);
            const label = folder
              ? folderPathLabel(folder, folderById)
              : t("aliases.unknownFolder");
            return (
              <li
                key={alias.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  <FolderIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate">{label}</span>
                </span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("aliases.removeAriaLabel")}
                    onClick={() => handleRemove(alias)}
                    disabled={removeAlias.isPending}
                  >
                    {removingId === alias.id ? (
                      <ArrowPathIcon className="animate-spin" />
                    ) : (
                      <TrashIcon />
                    )}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canWrite ? (
        <AddAliasDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          articleId={articleId}
          homeFolderId={homeFolderId}
          folders={folders ?? []}
          aliasedFolderIds={new Set(rows.map((a) => a.folderId))}
        />
      ) : null}
    </DetailPanel>
  );
}

/**
 * Inline picker dialog to alias the article into a folder (`POST /articles/:id/aliases`). The home
 * folder and folders already aliased are excluded from the options (both are rejected by the API);
 * each option shows the full folder path so nested folders with the same leaf name stay distinct.
 */
function AddAliasDialog({
  open,
  onOpenChange,
  articleId,
  homeFolderId,
  folders,
  aliasedFolderIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  articleId: string;
  homeFolderId: string;
  folders: Folder[];
  aliasedFolderIds: Set<string>;
}) {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const createAlias = useCreateArticleAlias();
  const [folderId, setFolderId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  // Selectable = every live folder except the home folder and the ones already aliased.
  const options = useMemo(
    () =>
      folders
        .filter(
          (f) => f.id !== homeFolderId && !aliasedFolderIds.has(f.id),
        )
        .map((f) => ({ id: f.id, label: folderPathLabel(f, folderById) }))
        .sort((a, b) =>
          a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
        ),
    [folders, homeFolderId, aliasedFolderIds, folderById],
  );

  function handleOpenChange(next: boolean) {
    if (!next) {
      setFolderId("");
      setError(null);
    }
    onOpenChange(next);
  }

  function handleCreate() {
    if (!folderId) {
      setError(t("aliases.chooseFolderError"));
      return;
    }
    setError(null);
    createAlias.mutate(
      { articleId, data: { folderId } },
      {
        onSuccess: () => {
          toast.success(t("aliases.toast.added"));
          handleOpenChange(false);
        },
        onError: (err) => notifyError(err, t("aliases.toast.addError")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aliases.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("aliases.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="alias-folder">
            {t("aliases.folderLabel")}
          </FieldLabel>
          <Select
            value={folderId}
            onValueChange={(value) => {
              setFolderId(value);
              if (error) setError(null);
            }}
          >
            <SelectTrigger
              id="alias-folder"
              className="w-full"
              aria-invalid={error ? true : undefined}
            >
              <SelectValue
                placeholder={
                  options.length > 0
                    ? t("aliases.folderSelect")
                    : t("aliases.folderNone")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError>{error}</FieldError>
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={createAlias.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleCreate}
            disabled={createAlias.isPending || options.length === 0}
          >
            {createAlias.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("aliases.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
