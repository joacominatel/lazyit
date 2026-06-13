"use client";

import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
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
import { useDeleteArticleCategoryCascade } from "@/lib/api/hooks/use-article-categories";
import { notifyError } from "@/lib/api/notify-error";

/**
 * FolderDeleteDialog — the confirm dialog for the per-folder "⋯ → Delete folder" cascade action
 * (#415, ADMIN-only — gated on `category:delete` by the trigger). It WARNS, in destructive tone, that
 * the folder, its sub-folders and their articles are removed from the KB, then calls the cascade
 * endpoint (`DELETE /article-categories/:id?cascade=true`) and shows the returned counts on success.
 *
 * Soft delete (auditability stance): rows are archived (recoverable in the DB), "gone" from the UI.
 * A pre-count of affected sub-folders is shown from the already-loaded tree data; the article count
 * is unknown until the server responds (no extra fetch), so the warning is phrased to cover both.
 */
export function FolderDeleteDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  descendantFolderCount,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  folderName: string;
  /** Direct + transitive sub-folders that will also be deleted, counted from the loaded tree. */
  descendantFolderCount: number;
  /** Side effect after a successful delete (e.g. clear the selection if the deleted folder was active). */
  onDeleted?: () => void;
}) {
  const t = useTranslations("kb");
  const cascadeDelete = useDeleteArticleCategoryCascade();
  const [isPending, setIsPending] = useState(false);

  async function handleDelete() {
    setIsPending(true);
    try {
      const result = await cascadeDelete.mutateAsync(folderId);
      toast.success(
        t("folders.delete.toast.deleted", {
          folders: result.deletedFolders,
          articles: result.deletedArticles,
        }),
      );
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      notifyError(error, t("folders.delete.toast.error"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ExclamationTriangleIcon
              className="size-5 shrink-0 text-destructive"
              aria-hidden
            />
            {t("folders.delete.title")}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {t.rich("folders.delete.warning", {
                  name: folderName,
                  b: (chunks) => (
                    <span className="font-medium text-foreground">{chunks}</span>
                  ),
                })}
              </p>
              {descendantFolderCount > 0 ? (
                <p>
                  {t("folders.delete.subfolderWarning", {
                    count: descendantFolderCount,
                  })}
                </p>
              ) : null}
              <p className="text-xs">{t("folders.delete.irreversibleNote")}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t("folders.delete.cancel")}
          </AlertDialogCancel>
          {/* Plain destructive button (not AlertDialogAction) so we own the spinner and only close on
              success — a 409/500 keeps the dialog open with the error toast. */}
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {t("folders.delete.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
