"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  CheckIcon,
  CommandLineIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { CreateServiceAccount, InfraNodeListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
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
import { useInfraNodes } from "@/lib/api/hooks/use-infra-nodes";
import { useCreateServiceAccount } from "@/lib/api/hooks/use-service-accounts";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";
import { ConfirmNodeDialog } from "./confirm-node-dialog";

/**
 * "Create a reporting agent" — the guided onboarding wizard (ADR-0074 §5/§6, epic #831). It evolves
 * the old single-shot "Add a server" dialog into a 3-step flow so a non-technical operator can stand
 * up their FIRST agent without reading docs:
 *
 *  1. **Name & generate** — a tiny form (just a name); mints a Service Account LOCKED to `infra:report`
 *     (no permission picker — the agent can do nothing else; a leaked token is at worst PENDING spam a
 *     human discards, §5/§8).
 *  2. **Install** — the ready-to-paste `curl … | sudo sh` one-liner with the REAL token injected, the
 *     Linux+root requirement, the once-only {@link SecretReveal} (copy / download / acknowledge +
 *     dialog-lock), and a collapsed "install manually" path for the cautious admin (matches install.sh
 *     + the agent's `/etc/lazyit-agent/config` contract).
 *  3. **Live wait** — polls the PENDING list (§3) for the NEW agent-reported host this install produced
 *     and celebrates the moment it checks in, with an inline Confirm.
 *
 * `<origin>` is `window.location.origin`, NOT a baked env: lazyit is self-hosted and domain-portable
 * (the installer targets the operator's OWN instance — §6). The real token exists only in the reveal's
 * render state; we read it there and inject it into the commands (the one place it can exist). Minting
 * an SA needs `settings:manage`, so the caller gates the entry affordance on it.
 */
export function CreateAgentWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // While the once-only token is shown and unacknowledged (step 2), lock the dialog against dismissal
  // (the same posture as the Service Accounts reveal — losing the token is irrecoverable, issue #813).
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
          <WizardBody
            onClose={() => onOpenChange(false)}
            onLockChange={setLocked}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Step = 1 | 2 | 3;

function WizardBody({
  onClose,
  onLockChange,
}: {
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const t = useTranslations("infra.wizard");
  const tc = useTranslations("common");
  const create = useCreateServiceAccount();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  // After a successful create, the once-only token to reveal + inject. Held in local state only.
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(
    null,
  );

  function handleGenerate(event?: React.FormEvent) {
    event?.preventDefault();
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
        setStep(2);
      },
      onError: (error) => notifyError(error, t("error")),
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("subtitle")}</DialogDescription>
      </DialogHeader>

      <StepIndicator step={step} />

      {step === 1 ? (
        <StepName
          name={name}
          onNameChange={setName}
          onGenerate={handleGenerate}
          onCancel={onClose}
          pending={create.isPending}
        />
      ) : null}

      {step === 2 && secret ? (
        <StepInstall
          token={secret.token}
          name={secret.name}
          onAcknowledge={() => setStep(3)}
          onLockChange={onLockChange}
        />
      ) : null}

      {step === 3 ? (
        <StepWait
          name={secret?.name ?? name}
          onClose={onClose}
          checkLaterLabel={t("checkLater")}
          doneLabel={tc("close")}
        />
      ) : null}
    </>
  );
}

/** The 1·2·3 progress markup (no stepper lib — internal step state + simple tokens, ADR-0049). */
function StepIndicator({ step }: { step: Step }) {
  const t = useTranslations("infra.wizard");
  const labels = [t("steps.name"), t("steps.install"), t("steps.wait")];
  return (
    <ol
      className="flex items-center gap-1.5 text-xs"
      aria-label={t("stepAria", { current: step, total: 3 })}
    >
      {labels.map((label, index) => {
        const n = index + 1;
        const done = n < step;
        const current = n === step;
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold",
                current && "bg-primary text-primary-foreground",
                done && "bg-primary/15 text-primary",
                !current && !done && "bg-muted text-muted-foreground",
              )}
            >
              {done ? <CheckIcon className="size-3" aria-hidden /> : n}
            </span>
            <span
              className={cn(
                "truncate",
                current
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </span>
            {index < labels.length - 1 ? (
              <span className="h-px flex-1 bg-border" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Step 1 — name the agent and mint its locked-down credentials. */
function StepName({
  name,
  onNameChange,
  onGenerate,
  onCancel,
  pending,
}: {
  name: string;
  onNameChange: (value: string) => void;
  onGenerate: (event?: React.FormEvent) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const t = useTranslations("infra.wizard");
  const tc = useTranslations("common");
  return (
    <>
      <p className="text-sm text-muted-foreground">{t("whatIsAgent")}</p>

      <form onSubmit={onGenerate} noValidate>
        <Field>
          <FieldLabel htmlFor="agent-name">{t("nameLabel")}</FieldLabel>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
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
          onClick={onCancel}
          disabled={pending}
        >
          {tc("cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => onGenerate()}
          disabled={pending || !name.trim()}
        >
          {pending && <ArrowPathIcon className="animate-spin" />}
          {t("generate")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Step 2 — the one-liner, the requirements, the manual fallback, and the once-only token reveal. */
function StepInstall({
  token,
  name,
  onAcknowledge,
  onLockChange,
}: {
  token: string;
  name: string;
  onAcknowledge: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const t = useTranslations("infra.wizard");
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://<your-instance>";
  const oneLiner = `curl -fsSL ${origin}/install.sh | sudo sh -s -- --url ${origin} --token ${token}`;

  // The credential-based manual path — mirrors install.sh + the agent's /etc/lazyit-agent/config
  // contract so a cautious admin can reproduce the installer by hand, step by step.
  const manualSteps = [
    {
      label: t("manual.step1"),
      command: `curl -fsSL -H "Authorization: Bearer ${token}" "${origin}/api/agent/download?arch=x64" -o lazyit-agent`,
    },
    {
      label: t("manual.step2"),
      command: "chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/",
    },
    {
      label: t("manual.step3"),
      command: `sudo install -d -m 700 /etc/lazyit-agent && printf 'LAZYIT_URL=%s\\nLAZYIT_TOKEN=%s\\n' "${origin}" "${token}" | sudo tee /etc/lazyit-agent/config >/dev/null && sudo chmod 600 /etc/lazyit-agent/config`,
    },
    {
      label: t("manual.step4"),
      command: "sudo lazyit-agent report --once",
    },
  ];

  return (
    <div className="space-y-4">
      <Callout
        tone="info"
        icon={<CommandLineIcon />}
        className="rounded-lg text-sm"
      >
        {t("requirements")}
      </Callout>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          {t("installTitle")}
        </p>
        <CommandBlock command={oneLiner} />
        <p className="text-xs text-muted-foreground">{t("installHint")}</p>
      </div>

      <details className="group rounded-lg border bg-muted/30">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-foreground select-none">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
              ›
            </span>
            {t("manual.toggle")}
          </span>
        </summary>
        <div className="space-y-3 px-3 pt-1 pb-3">
          <p className="text-xs text-muted-foreground">{t("manual.intro")}</p>
          <ol className="space-y-3">
            {manualSteps.map((manualStep, index) => (
              <li key={manualStep.command} className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {index + 1}.
                  </span>{" "}
                  {manualStep.label}
                </p>
                <CommandBlock command={manualStep.command} />
              </li>
            ))}
          </ol>
        </div>
      </details>

      <SecretReveal
        name={name}
        token={token}
        action="created"
        onAcknowledge={onAcknowledge}
        onLockedChange={onLockChange}
      />
    </div>
  );
}

/**
 * Step 3 — wait for the freshly-installed agent to check in. Polls the PENDING list every 5s (ADR-0074
 * §3) and detects the NEW host: when this step opens we snapshot the agent-reported PENDING node ids
 * already present; the first PENDING agent node NOT in that baseline is "the one" this install produced.
 * Stops polling on close (the query's `enabled` is gated on this step being mounted). The node sits in
 * the Pending review tray regardless, so "I'll check later" is always a safe escape.
 */
function StepWait({
  name,
  onClose,
  checkLaterLabel,
  doneLabel,
}: {
  name: string;
  onClose: () => void;
  checkLaterLabel: string;
  doneLabel: string;
}) {
  const t = useTranslations("infra.wizard");
  const { data: pending } = useInfraNodes(
    { state: "PENDING" },
    { enabled: true, refetchInterval: 5000 },
  );
  const baselineRef = useRef<Set<string> | null>(null);
  const [found, setFound] = useState<InfraNodeListItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!pending) return;
    const agentPending = pending.filter((node) => node.source === "AGENT");
    // First data tick after entering the step: capture the pre-existing set, claim nothing yet.
    if (baselineRef.current === null) {
      baselineRef.current = new Set(agentPending.map((node) => node.id));
      return;
    }
    if (!found) {
      const fresh = agentPending.find(
        (node) => !baselineRef.current?.has(node.id),
      );
      if (fresh) setFound(fresh);
    }
  }, [pending, found]);

  if (found) {
    return (
      <>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <CheckCircleIcon
            className="size-12 text-success motion-safe:animate-in motion-safe:zoom-in-50"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-base font-semibold">
              {t("successTitle", { name: found.label })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("successDescription")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {doneLabel}
          </Button>
          <Button type="button" onClick={() => setConfirmOpen(true)}>
            <CheckIcon />
            {t("confirmAction")}
          </Button>
        </DialogFooter>

        {confirmOpen ? (
          <ConfirmNodeDialog
            open
            onOpenChange={(value) => !value && setConfirmOpen(false)}
            node={found}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <ArrowPathIcon
          className="size-10 text-muted-foreground motion-safe:animate-spin"
          aria-hidden
        />
        <div className="space-y-1">
          <p className="text-base font-semibold">{t("waitTitle", { name })}</p>
          <p className="text-sm text-muted-foreground">{t("waitDescription")}</p>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {checkLaterLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * A copyable command block — the `font-mono` `<pre>` + the shared {@link CopyButton}. Reused for the
 * one-liner and every manual step so the copy affordance reads identically across the wizard.
 */
function CommandBlock({ command }: { command: string }) {
  const t = useTranslations("infra.wizard");
  return (
    <div className="space-y-2 rounded-lg border bg-muted/50 p-2">
      <pre className="overflow-x-auto font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">
        <code>{command}</code>
      </pre>
      <CopyButton
        value={command}
        label={t("copyCommandAria")}
        toastMessage={t("commandCopied")}
      />
    </div>
  );
}
