"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
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
import type { ConfirmableMoveAudienceChange } from "@/lib/utils/kb-move-audience";

/**
 * MoveAudienceConfirmDialog — the one confirmation every Knowledge Base move routes through when it
 * may let more people read a document (ADR-0060 §9, #1529). The verdict comes from
 * `classifyArticleMove` / `classifyFolderMove`; this component only words it.
 *
 * The API allows a widening move on purpose — publishing a document drafted in a restricted folder is
 * a normal workflow — so the control is informed consent, not prohibition. The copy names the
 * consequence plainly. For a move between two differently restricted places it says the audience
 * CHANGES and may widen: the folder flag is one bit, and it cannot tell which way the audience moves.
 *
 * Cancel (or Escape) runs `onCancel`, which aborts the move and leaves everything as it was; confirm
 * runs `onConfirm`. Rendered closed while `change` is `null`, so the caller closes it by clearing it.
 */
export function MoveAudienceConfirmDialog({
  change,
  subject,
  name,
  destination,
  onConfirm,
  onCancel,
}: {
  /** The verdict to confirm, or `null` while there is nothing to ask. */
  change: ConfirmableMoveAudienceChange | null;
  /** What is moving: one article, or a folder with every article below it. */
  subject: "article" | "folder";
  /** The article title or folder name, quoted in the prompt. */
  name: string;
  /** The destination, already worded (a folder path, or "the top level"). */
  destination: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("kb.moveAudience");
  // Keep the last prompt on screen while the dialog animates closed: the caller clears `change` (and
  // usually the name) the moment it proceeds, and the copy must not flip mid-fade.
  const [shown, setShown] = useState({ change, name, destination });
  if (
    change !== null &&
    (change !== shown.change ||
      name !== shown.name ||
      destination !== shown.destination)
  ) {
    setShown({ change, name, destination });
  }
  const widens = shown.change === "widens-to-public";
  const key = `${subject}.${widens ? "widens" : "changes"}` as const;

  return (
    <AlertDialog
      open={change !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${key}.title`)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(`${key}.description`, {
              name: shown.name,
              destination: shown.destination,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          {/* A plain Button, not AlertDialogAction: the action's built-in close would also fire the
              dismiss path, and `onCancel` must only ever mean "the move did not happen". The caller
              closes the dialog by clearing `change` as it proceeds. */}
          <Button onClick={onConfirm}>
            {t(widens ? "confirmWidens" : "confirmChanges")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
