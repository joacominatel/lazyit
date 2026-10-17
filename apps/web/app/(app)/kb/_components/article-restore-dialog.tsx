"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ArticleListItem } from "@lazyit/shared";
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
import { useRestoreArticle } from "@/lib/api/hooks/use-article-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { articleRestoreErrorKind } from "@/lib/utils/article-restore-error";

export function ArticleRestoreDialog({
  article,
  onClose,
}: {
  article: ArticleListItem | null;
  onClose: () => void;
}) {
  const t = useTranslations("kb.archived");
  const restore = useRestoreArticle();
  // Keep the last title on screen while the dialog animates closed.
  const [shown, setShown] = useState(article);
  if (article !== null && article !== shown) setShown(article);

  async function handleRestore() {
    if (!article) return;
    try {
      await restore.mutateAsync(article.id);
      toast.success(t("restored", { title: article.title }));
      onClose();
    } catch (error) {
      if (articleRestoreErrorKind(error) === "slugTaken") {
        toast.error(t("errors.slugTaken", { slug: article.slug }));
      } else {
        notifyError(error, t("restoreError"));
      }
    }
  }

  return (
    <AlertDialog
      open={article !== null}
      onOpenChange={(open) => {
        if (!open && !restore.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("confirmDescription", { title: shown?.title ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={restore.isPending}>{t("cancel")}</AlertDialogCancel>
          <Button onClick={handleRestore} disabled={restore.isPending}>
            {restore.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
