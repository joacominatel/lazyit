"use client";

import {
  ArrowDownTrayIcon,
  CheckIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  PERSONAL_TOKEN_DEFAULT_EXPIRY_DAYS,
  PERSONAL_TOKEN_MAX_EXPIRY_DAYS,
  type PersonalTokenCreated,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { useCreatePersonalToken } from "@/lib/api/hooks/use-oauth-grants";
import { copyText } from "../_lib/copy-text";

/** Expiry choices, in days. The default (90) and the maximum (365) come from the shared contract. */
const EXPIRY_CHOICES = [30, PERSONAL_TOKEN_DEFAULT_EXPIRY_DAYS, 180, PERSONAL_TOKEN_MAX_EXPIRY_DAYS];

type Access = "read" | "read-write";

/**
 * Create a personal MCP token (plain-HTTP instances; mcp-and-oauth.md §14). Two steps in one dialog:
 * the form (name, mandatory expiry, read-only or read & write — never admin), then the one-time reveal.
 *
 * The cleartext token lives only in this dialog's state: the mutation is reset as soon as it answers
 * (and has `gcTime: 0`), so neither the query nor the mutation cache keeps it, and it is dropped when
 * the dialog closes. While it is shown and unacknowledged the dialog cannot
 * be dismissed by accident (the #813 lock).
 */
export function PersonalTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("oauth.personalTokens.create");
  const [created, setCreated] = useState<PersonalTokenCreated | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const locked = created !== null && !acknowledged;

  function close() {
    setCreated(null);
    setAcknowledged(false);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else if (!locked) close();
      }}
    >
      <DialogContent
        showCloseButton={!locked}
        onEscapeKeyDown={locked ? (e) => e.preventDefault() : undefined}
        onInteractOutside={locked ? (e) => e.preventDefault() : undefined}
      >
        {created ? (
          <TokenReveal
            created={created}
            acknowledged={acknowledged}
            onAcknowledgedChange={setAcknowledged}
            onDone={close}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>
            <CreateForm onCreated={setCreated} onCancel={close} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (created: PersonalTokenCreated) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("oauth.personalTokens.create");
  const create = useCreatePersonalToken();
  const nameId = useId();
  const expiryId = useId();
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(
    PERSONAL_TOKEN_DEFAULT_EXPIRY_DAYS,
  );
  const [access, setAccess] = useState<Access>("read-write");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setError(t("errors.nameRequired"));
      return;
    }
    setError(null);
    create.mutate(
      {
        label: trimmed,
        expiresInDays,
        scopes:
          access === "read"
            ? ["lazyit.read"]
            : ["lazyit.read", "lazyit.write"],
      },
      {
        onSuccess: (created) => {
          onCreated(created);
          // Drop the token from the mutation cache; the reveal keeps its own copy (gcTime is 0 too).
          create.reset();
        },
        onError: (err) => {
          setError(createErrorMessage(err, t));
          create.reset();
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor={nameId}>{t("name")}</Label>
        <Input
          id={nameId}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
          placeholder={t("namePlaceholder")}
          autoComplete="off"
          aria-invalid={error === t("errors.nameRequired") || undefined}
        />
        <p className="text-xs text-muted-foreground">{t("nameHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={expiryId}>{t("expiry")}</Label>
        <Select
          value={String(expiresInDays)}
          onValueChange={(v) => setExpiresInDays(Number(v))}
        >
          <SelectTrigger id={expiryId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_CHOICES.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {t("expiryDays", { days })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("expiryHint")}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("access")}</legend>
        {(["read", "read-write"] as const).map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name="access"
              value={value}
              checked={access === value}
              onChange={() => setAccess(value)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              <span className="font-medium">{t(`accessOptions.${value}.label`)}</span>
              <span className="block text-muted-foreground">
                {t(`accessOptions.${value}.description`)}
              </span>
            </span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{t("noAdmin")}</p>
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The API's refusals, explained (`OAUTH_INSTANCE`, `AI_DISABLED`, the per-user cap). */
function createErrorMessage(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
): string {
  if (error instanceof ApiError) {
    const code = (error.body as { code?: unknown } | undefined)?.code;
    if (error.status === 403 && code === "OAUTH_INSTANCE") {
      return t("errors.oauthInstance");
    }
    if (error.status === 403 && code === "AI_DISABLED") {
      return t("errors.aiDisabled");
    }
    if (error.status === 409) return t("errors.limit");
    if (error.status === 403) return t("errors.forbidden");
  }
  return t("errors.generic");
}

function TokenReveal({
  created,
  acknowledged,
  onAcknowledgedChange,
  onDone,
}: {
  created: PersonalTokenCreated;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  onDone: () => void;
}) {
  const t = useTranslations("oauth.personalTokens.reveal");
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    if (await copyText(created.token)) {
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(t("copyUnavailable"));
    }
  }

  function onDownload() {
    const url = URL.createObjectURL(
      new Blob([created.token], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lazyit-personal-token.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Deferred: revoking synchronously can cancel the download before the browser has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>
          {t("description", { name: created.grant.label ?? "" })}
        </DialogDescription>
      </DialogHeader>

      <Callout tone="warning" icon={<ExclamationTriangleIcon />} className="text-sm">
        {t("warning")}
      </Callout>

      <div className="space-y-2 rounded-lg border bg-muted/50 p-2">
        <code className="block w-full overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap select-all">
          {created.token}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCopy}
            aria-label={t("copyAria")}
          >
            {copied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
            {copied ? t("copiedShort") : t("copy")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDownload}
            aria-label={t("downloadAria")}
          >
            <ArrowDownTrayIcon aria-hidden />
            {t("download")}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t("next")}</p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledgedChange(e.target.checked)}
          className="mt-0.5 size-4 rounded border-input accent-primary"
        />
        <span>{t("acknowledge")}</span>
      </label>

      <DialogFooter>
        <Button type="button" onClick={onDone} disabled={!acknowledged}>
          {t("done")}
        </Button>
      </DialogFooter>
    </div>
  );
}
