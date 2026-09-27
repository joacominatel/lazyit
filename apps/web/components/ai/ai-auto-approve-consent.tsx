"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const POINTS = ["basic", "critical", "othersContent", "logged", "off"] as const;

/**
 * The consent asked before auto-approve is first turned on in this browser (#1376). The CEO's rule: the
 * mode is the user's call and consent — so it says plainly what it does and what still asks, and the
 * user confirms. Cancel is the default action; Esc and the overlay cancel too.
 */
export function AiAutoApproveConsent({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("ai.settings.consent");

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent
        className="data-[size=default]:sm:max-w-md"
        // Esc closes the dialog only — never the (non-modal) chat panel it was opened from.
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("intro")}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          {POINTS.map((key) => (
            <li key={key}>{t(`points.${key}`)}</li>
          ))}
        </ul>
        <Link
          href="/help/ai-assistant-approvals"
          prefetch={false}
          className="text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          {t("manual")}
        </Link>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("confirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
