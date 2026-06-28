"use client";

import {
  ArrowPathIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { CreateServiceAccount } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { SecretReveal } from "@/app/(app)/settings/service-accounts/_components/secret-reveal";
import { Callout } from "@/components/callout";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useCreateServiceAccount } from "@/lib/api/hooks/use-service-accounts";
import { notifyError } from "@/lib/api/notify-error";

/**
 * "Add a server" (ADR-0074 §6) — mint a Service Account scoped to ONLY `infra:report` and hand the
 * operator the one-time install one-liner for the self-installing Linux reporting agent. Two phases:
 *
 *  1. A tiny form (just a name) — the permission is LOCKED to `infra:report` (the agent can do nothing
 *     else; a leaked token is at worst PENDING spam a human discards — §5/§8). No permission picker.
 *  2. The one-time reveal: the ready-to-paste `curl … | sudo sh` install command with the REAL token
 *     injected, plus the raw token via the shared {@link SecretReveal} (copy / download / acknowledge,
 *     and its dialog-lock against accidental dismissal — the token is shown exactly once).
 *
 * `<origin>` is `window.location.origin`, NOT a baked env: lazyit is self-hosted and domain-portable
 * (the installer targets the operator's OWN instance — §6), so the command must point wherever this UI
 * is being served from. The real token only exists in the reveal's render state; we read it there and
 * inject it into the one-liner (the one place it can exist). Minting an SA needs `settings:manage`, so
 * the caller gates the entry button on it.
 */
export function AddServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // While the once-only token is shown and unacknowledged, lock the dialog against dismissal (the same
  // posture as the Service Accounts reveal — losing the token is irrecoverable, issue #813).
  const [locked, setLocked] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (locked && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        showCloseButton={!locked}
        onEscapeKeyDown={locked ? (e) => e.preventDefault() : undefined}
        onInteractOutside={locked ? (e) => e.preventDefault() : undefined}
      >
        {open ? (
          <AddServerBody
            onClose={() => onOpenChange(false)}
            onLockChange={setLocked}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AddServerBody({
  onClose,
  onLockChange,
}: {
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const t = useTranslations("infra.addServer");
  const tc = useTranslations("common");
  const create = useCreateServiceAccount();
  const [name, setName] = useState("");
  // After a successful create, the once-only token to reveal. Held in local state only — never cached.
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(
    null,
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const body: CreateServiceAccount = {
      name: trimmed,
      permissions: ["infra:report"],
    };
    create.mutate(body, {
      onSuccess: (result) => {
        toast.success(t("createdToast"));
        setSecret({ name: result.name, token: result.token });
      },
      onError: (error) => notifyError(error, t("error")),
    });
  }

  if (secret) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("revealTitle")}</DialogTitle>
          <DialogDescription>{t("revealDescription")}</DialogDescription>
        </DialogHeader>
        <InstallCommand token={secret.token} />
        {/* No `permissions` → no test-it curl block; the install one-liner above is the verification. */}
        <SecretReveal
          name={secret.name}
          token={secret.token}
          action="created"
          onAcknowledge={onClose}
          onLockedChange={onLockChange}
        />
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} noValidate>
        <Field>
          <FieldLabel htmlFor="add-server-name">{t("nameLabel")}</FieldLabel>
          <Input
            id="add-server-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            maxLength={120}
            autoFocus
          />
          <FieldDescription>{t("nameHint")}</FieldDescription>
        </Field>
      </form>

      <Callout
        tone="info"
        icon={<InformationCircleIcon />}
        className="rounded-lg text-sm"
      >
        {t("scopeNote")}
      </Callout>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={create.isPending}
        >
          {tc("cancel")}
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={create.isPending || !name.trim()}
        >
          {create.isPending && <ArrowPathIcon className="animate-spin" />}
          {t("submit")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The ready-to-paste install one-liner (ADR-0074 §6). `<origin>` is the live `window.location.origin`
 * so the command targets THIS instance (self-hosted, domain-portable — never a baked env). The REAL
 * token is injected here because this is the only place it exists (the reveal's render state).
 */
function InstallCommand({ token }: { token: string }) {
  const t = useTranslations("infra.addServer");
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://<your-instance>";
  const command = `curl -fsSL ${origin}/install.sh | sudo sh -s -- --url ${origin} --token ${token}`;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{t("installTitle")}</p>
      <div className="space-y-2 rounded-lg border bg-muted/50 p-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed select-all">
          <code>{command}</code>
        </pre>
        <CopyButton
          value={command}
          label={t("copyInstallAria")}
          toastMessage={t("installCopied")}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("installHint")}</p>
    </div>
  );
}
