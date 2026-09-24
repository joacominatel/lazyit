"use client";

import { ArrowPathIcon, PowerIcon } from "@heroicons/react/24/outline";
import type { AiSettings } from "@lazyit/shared";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config";
import { buildUpdate } from "../_lib/ai-settings-form";
import { AiErrorNotice } from "./ai-error-notice";

/**
 * Turn the assistant off (frontend.md §5.3 "Danger zone"; §11 item 4). The confirm dialog lists what
 * happens: the chat disappears for everyone, conversations and connected apps stay dormant (retention
 * keeps running), the configuration and the key are kept for turning it back on, and MCP — its own
 * switch — is not touched. Then a hard reload, like the enable.
 */
export function AiDangerZone({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.danger");
  const [open, setOpen] = useState(false);
  const save = useAiConfigSave();

  function turnOff() {
    save.save(
      buildUpdate(settings, { enabled: false }),
      // A HARD reload on purpose (frontend.md Fork E): it resets every client state, the chat included.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      () => window.location.assign("/settings/ai"),
    );
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
          <PowerIcon />
          {t("turnOff")}
        </Button>
      </CardContent>

      <AlertDialog open={open} onOpenChange={(next) => !save.isPending && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("confirm.chat")}</li>
            <li>{t("confirm.dormant")}</li>
            <li>{t("confirm.kept")}</li>
            <li>{t("confirm.mcp")}</li>
          </ul>
          <AiErrorNotice error={save.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>{t("confirm.cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={turnOff}
              disabled={save.isPending}
            >
              {save.isPending ? <ArrowPathIcon className="animate-spin" /> : <PowerIcon />}
              {t("confirm.action")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
