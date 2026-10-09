"use client";

import { ArrowPathIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { AiErrorNotice } from "./ai-error-notice";

/**
 * The consent step for a switch that sends data out of lazyit (#1540). The "What leaves lazyit" text
 * lives in the switch's "?" tip day to day; turning the switch ON opens this dialog with the full
 * disclosure, and only its confirm button saves. Turning it off needs no confirmation
 * (`egressNeedsConsent`). The dialog stays open while saving and closes on success (the caller).
 */
export function AiEgressConfirm({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm,
  isPending,
  error,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  isPending: boolean;
  /** The failed save, shown inside the dialog so it is not hidden behind it. */
  error?: unknown;
  /** The disclosure — what is sent, to whom. */
  children: ReactNode;
}) {
  const t = useTranslations("aiSettings.consent");
  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <Callout tone="info" icon={<InformationCircleIcon />}>
          {children}
        </Callout>
        <AiErrorNotice error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t("cancel")}</AlertDialogCancel>
          <Button type="button" onClick={onConfirm} disabled={isPending}>
            {isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
