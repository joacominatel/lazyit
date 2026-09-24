"use client";

import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  AI_SERVICE_ACCOUNT_ACCESS_LEVELS,
  type AiServiceAccountAccess,
  type AiServiceAccountSettings,
  type ServiceAccount,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { RequestIdNote } from "@/components/request-id-note";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import {
  useAiServiceAccountSettings,
  useUpdateAiServiceAccountSettings,
} from "@/lib/api/hooks/use-ai-config";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";
import { aiAccessBody, aiAccessNotes } from "./ai-access";

/**
 * A Service Account's AI access (ADR-0097 decision 4; frontend.md §5.3 "Headless"; K2
 * `/config/ai/service-accounts/:id`). Off / read-only / read-write, plus an optional cap on writes. The
 * setting only narrows the account's grants; the dialog says what else it needs (`ai:use` for headless
 * runs, `ai:connect` for `/mcp`) and that an `infra:report` account is refused whatever is chosen. The
 * cap counts executed writes per headless run and, over MCP (which has no runs), writes per rolling hour.
 */
export function AiAccessDialog({
  account,
  open,
  onOpenChange,
}: {
  account: ServiceAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("settings.serviceAccounts.aiAccess");
  const query = useAiServiceAccountSettings(open ? account.id : undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { name: account.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError || !query.data ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />} role="alert">
            <p className="text-sm">
              {query.error instanceof ApiError && query.error.status === 404
                ? t("errors.notFound")
                : query.error instanceof ApiError && query.error.status === 403
                  ? t("errors.forbidden")
                  : t("errors.load")}
            </p>
            <RequestIdNote
              requestId={query.error instanceof ApiError ? query.error.requestId : undefined}
            />
          </Callout>
        ) : (
          <AiAccessForm
            key={account.id}
            account={account}
            initial={query.data}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AiAccessForm({
  account,
  initial,
  onDone,
}: {
  account: ServiceAccount;
  initial: AiServiceAccountSettings;
  onDone: () => void;
}) {
  const t = useTranslations("settings.serviceAccounts.aiAccess");
  const tc = useTranslations("common");
  const id = useId();
  const save = useUpdateAiServiceAccountSettings(account.id);
  const [access, setAccess] = useState<AiServiceAccountAccess>(initial.access);
  const [capOn, setCapOn] = useState(initial.maxMutationsPerRun !== null);
  const [cap, setCap] = useState(
    initial.maxMutationsPerRun !== null ? String(initial.maxMutationsPerRun) : "",
  );

  const body = aiAccessBody(access, capOn, cap);
  const notes = aiAccessNotes(account.permissions, access);
  // `body` is undefined only for read-write with an unusable cap: the one state that blocks Save.
  const saveBlocked = body === undefined;

  function onSave() {
    if (!body) return;
    save.mutate(body, {
      onSuccess: () => {
        toast.success(t("saved", { name: account.name }));
        onDone();
      },
      onError: (error) => notifyError(error, t("errors.save")),
    });
  }

  return (
    <>
      <div className="space-y-4">
        <RadioGroup
          value={access}
          onValueChange={(value) => setAccess(value as AiServiceAccountAccess)}
          aria-label={t("levelLabel")}
        >
          {AI_SERVICE_ACCOUNT_ACCESS_LEVELS.map((level) => (
            <label
              key={level}
              htmlFor={`${id}-${level}`}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40",
                access === level && "border-primary bg-muted/30",
              )}
            >
              <RadioGroupItem value={level} id={`${id}-${level}`} className="mt-0.5" />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{t(`levels.${level}.label`)}</span>
                <span className="block text-sm text-muted-foreground">
                  {t(`levels.${level}.description`)}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>

        {access === "read-write" ? (
          <div className="space-y-3 rounded-lg border p-3">
            <Field orientation="horizontal">
              <div className="flex flex-1 flex-col gap-0.5">
                <FieldLabel htmlFor={`${id}-cap-on`} className="font-medium">
                  {t("cap.toggle")}
                </FieldLabel>
                <FieldDescription>{t("cap.description")}</FieldDescription>
              </div>
              <Switch id={`${id}-cap-on`} checked={capOn} onCheckedChange={setCapOn} />
            </Field>
            {capOn ? (
              <Field data-invalid={saveBlocked || undefined}>
                <FieldLabel htmlFor={`${id}-cap`}>{t("cap.label")}</FieldLabel>
                <Input
                  id={`${id}-cap`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  aria-invalid={saveBlocked || undefined}
                  className="w-32 font-mono tabular-nums"
                />
                {saveBlocked ? (
                  <FieldError>{t("cap.invalid")}</FieldError>
                ) : (
                  <FieldDescription>{t("cap.hint")}</FieldDescription>
                )}
              </Field>
            ) : null}
          </div>
        ) : null}

        {notes.length > 0 ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <ul className="space-y-1 text-sm">
              {notes.map((note) => (
                <li key={note}>{t(`notes.${note}`)}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
      </div>
      <DialogFooter className="items-center">
        {saveBlocked ? (
          <p className="mr-auto text-sm text-muted-foreground" role="status">
            {t("cap.saveBlocked")}
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          {tc("cancel")}
        </Button>
        <Button type="button" onClick={onSave} disabled={save.isPending || !body}>
          {save.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
          {tc("save")}
        </Button>
      </DialogFooter>
    </>
  );
}
