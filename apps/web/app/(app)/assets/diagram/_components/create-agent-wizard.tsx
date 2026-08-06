"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  CheckIcon,
  CommandLineIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import {
  isContainerChildExternalId,
  isGuestChildExternalId,
  type CreateServiceAccount,
  type InfraNodeListItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SecretReveal } from "@/app/(app)/settings/service-accounts/_components/secret-reveal";
import { Callout } from "@/components/callout";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  useInfraNodeDetail,
  useInfraNodes,
} from "@/lib/api/hooks/use-infra-nodes";
import { useCreateServiceAccount } from "@/lib/api/hooks/use-service-accounts";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";
import {
  countPendingGuests,
  hypervisorFacetOf,
  hypervisorPlatformLabel,
} from "@/lib/agent/hypervisor-detection";
import {
  AGENT_PLATFORMS,
  type AgentPlatform,
  agentDiagnosticsCommand,
  agentInstallCommand,
  agentManualInstallSteps,
} from "@/lib/agent/install-commands";
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
      {/* `sm:max-w-2xl` (the clone-user wizard's width, #1225) rather than the form-dialog `lg`:
          step 2's one-liner carries a full origin + an opaque token, and at `lg` it wrapped
          MID-TOKEN — the exact string an operator must trust reads as two broken halves. */}
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
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

/**
 * Step 2 — the platform choice, the one-liner, the requirements, the inspect-first fallback, the
 * post-install check, and the once-only token reveal.
 *
 * The platform switch is the point of #1168. Minting the Service Account and handing over the token
 * is platform-neutral and always was; everything printed AROUND it assumed Linux, so an operator
 * installing on Windows was handed a `curl … | sh` their host cannot run, at the one moment they are
 * holding a token that is shown once and never again. The agent has been cross-platform since
 * ADR-0074's Windows amendment (#1144) and the Manual has carried the PowerShell form since then —
 * this wizard was the last surface that had not learned it.
 *
 * `linux` stays the default: it is what most of an estate's *servers* are, and it keeps the flow one
 * paste long for everyone it already served.
 */
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
  const [platform, setPlatform] = useState<AgentPlatform>("linux");
  // ADR-0095 §8's host-owner veto, surfaced as the ONE advanced option (#1225). Default unchecked:
  // guest collection is the default, and the flag is negative on purpose.
  const [noHypervisor, setNoHypervisor] = useState(false);
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://<your-instance>";

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-foreground">
          {t("platform.label")}
        </legend>
        <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
          {AGENT_PLATFORMS.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={platform === candidate ? "default" : "ghost"}
              className="flex-1"
              aria-pressed={platform === candidate}
              onClick={() => setPlatform(candidate)}
            >
              {candidate === "windows" ? t("platform.windows") : t("platform.linux")}
            </Button>
          ))}
        </div>
      </fieldset>

      <PlatformInstall
        platform={platform}
        origin={origin}
        token={token}
        noHypervisor={noHypervisor}
        onNoHypervisorChange={setNoHypervisor}
      />

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
 * Everything in step 2 that differs by platform.
 *
 * The commands themselves live in {@link agentInstallCommand} & co — pure, and asserted against the
 * two installers this instance actually serves, because "the command we print is the command
 * install.ps1 accepts" is a claim, not a comment.
 */
function PlatformInstall({
  platform,
  origin,
  token,
  noHypervisor,
  onNoHypervisorChange,
}: {
  platform: AgentPlatform;
  origin: string;
  token: string;
  noHypervisor: boolean;
  onNoHypervisorChange: (value: boolean) => void;
}) {
  const t = useTranslations("infra.wizard");
  const isWindows = platform === "windows";
  // The flag the veto checkbox appends, named in its hint so the operator can grep for it later.
  const vetoFlag = isWindows ? "-NoHypervisor" : "--no-hypervisor";

  // ONE structure, label key and command together. These used to be two positionally-indexed arrays
  // — the labels listed here, the commands built in the module — and nothing tied index N of one to
  // index N of the other, so an edit could add a step to one side only and no test would notice.
  // `lib/agent/install-commands.test.ts` holds every `labelKey` below to the `stepN` keys both locale
  // catalogs actually ship.
  const manualSteps = agentManualInstallSteps(platform, origin, token);

  return (
    <>
      <Callout
        tone="info"
        icon={<CommandLineIcon />}
        className="rounded-lg text-sm"
      >
        {isWindows ? t("requirements.windows") : t("requirements.linux")}
      </Callout>

      {/* Hypervisor discoverability (#1225, ADR-0095 §8). Deliberately a CALLOUT and not a third
          platform button: a Proxmox/Hyper-V/libvirt host IS a Linux or Windows server, and the
          command is IDENTICAL — detection lives in the agent and re-runs every tick. A third
          button would say the opposite of the truth it exists to teach. */}
      <Callout
        tone="info"
        icon={<ServerStackIcon />}
        className="rounded-lg text-sm"
      >
        {t.rich("hypervisorNote", {
          link: (chunks) => (
            <Link
              href="/help/assets-topology-hypervisors"
              className="underline underline-offset-4"
            >
              {chunks}
            </Link>
          ),
        })}
      </Callout>

      {/* Said BEFORE they click, not after SmartScreen has. ADR-0074's Windows amendment records the
          unsigned build as a deliberate internal-validation state with an explicit OV/EV gate before
          third-party distribution — an operator who meets that warning without having been told
          reasonably concludes the download is malicious, and stops. */}
      {isWindows ? (
        <Callout
          tone="warning"
          icon={<ExclamationTriangleIcon />}
          className="rounded-lg text-sm"
        >
          {t("unsigned")}
        </Callout>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          {t("installTitle")}
        </p>
        <CommandBlock
          command={agentInstallCommand(platform, origin, token, { noHypervisor })}
        />
        <p className="text-xs text-muted-foreground">
          {isWindows ? t("installHint.windows") : t("installHint.linux")}
        </p>
      </div>

      {/* The one advanced option (#1225): ADR-0095 §8's host-owner veto, collapsed because the
          default — inventory the guests — is the right answer for almost everyone. Checking it
          rewrites the command ABOVE (the builder appends the platform's veto flag), so the paste
          stays one artifact and the flag can never be forgotten separately. */}
      <details className="group rounded-lg border bg-muted/30">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-foreground select-none">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
              ›
            </span>
            {t("advanced.toggle")}
          </span>
        </summary>
        <div className="px-3 pt-1 pb-3">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={noHypervisor}
              onCheckedChange={(value) => onNoHypervisorChange(value === true)}
              className="mt-0.5"
            />
            <span className="space-y-0.5">
              <span className="block text-sm text-foreground">
                {t("advanced.noHypervisor")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("advanced.noHypervisorHint", { flag: vetoFlag })}
              </span>
            </span>
          </label>
        </div>
      </details>

      <details className="group rounded-lg border bg-muted/30">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-foreground select-none">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none">
              ›
            </span>
            {isWindows ? t("manual.windows.toggle") : t("manual.linux.toggle")}
          </span>
        </summary>
        <div className="space-y-3 px-3 pt-1 pb-3">
          <p className="text-xs text-muted-foreground">
            {isWindows ? t("manual.windows.intro") : t("manual.linux.intro")}
          </p>
          <ol className="space-y-3">
            {manualSteps.map((step, index) => (
              <li key={step.labelKey} className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {index + 1}.
                  </span>{" "}
                  {t(step.labelKey)}
                </p>
                <CommandBlock command={step.command} />
              </li>
            ))}
          </ol>
        </div>
      </details>

      {/* The check an operator reaches for when a host stays quiet — and the one that failed them on
          Windows, where the install directory used to be off PATH entirely. #1167 has since landed,
          so the bare `lazyit-agent test` resolves in a NEW shell; the absolute form printed here is
          kept because the shell this gets pasted into is usually the elevated PowerShell the install
          just ran in, which never sees the new entry. It needed no revision when #1167 landed, which
          was the point of choosing it.

          The Windows note carries the OTHER half of what the Linux `sudo` carries in the command
          itself: this check needs an elevated PowerShell, because install.ps1 ACLs the config file to
          SYSTEM + Administrators and the agent reads an unreadable config as an absent one. Without
          it the operator gets "no URL configured" on a host that installed perfectly. */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          {t("diagnostics.title")}
        </p>
        <CommandBlock command={agentDiagnosticsCommand(platform)} />
        <p className="text-xs text-muted-foreground">
          {t("diagnostics.hint")}
          {isWindows ? ` ${t("diagnostics.windowsNote")}` : null}
        </p>
      </div>
    </>
  );
}

/**
 * Step 3 — wait for the freshly-installed agent to check in. Polls the PENDING list every 5s (ADR-0074
 * §3) and detects the NEW host: when this step opens we snapshot the agent-reported PENDING node ids
 * already present; the first PENDING agent node NOT in that baseline is "the one" this install produced.
 * Stops polling on close (the query's `enabled` is gated on this step being mounted). The node sits in
 * the Pending review tray regardless, so "I'll check later" is always a safe escape.
 *
 * Container CHILDREN are excluded from the match (#1139), and hypervisor GUEST children with them
 * (#1225): a host that runs containers or VMs enrols them in the SAME request, immediately after
 * itself, and the list is newest-first — so without this filter the wizard would announce `redis`
 * (or `vm-101`) as the server the operator just installed the agent on. The children are still in
 * the tray; they are simply not the thing this step is waiting for.
 *
 * When the found host's first report carried the ADR-0095 hypervisor facet, the success screen also
 * says so (#1225): the platform detected (off the node's drill-in — the polled list deliberately
 * carries no `specs`, #1135) and how many guest children entered Pending review (counted off the
 * pending list already in hand), with a CTA into the tray.
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

  // Hypervisor detection feedback (#1225, ADR-0095). The list row deliberately carries no `specs`
  // (#1135), so the facet comes off the found node's drill-in — ONE fetch, once, the same read the
  // node panel does — while the guest children are counted straight out of the PENDING list this
  // step is already polling (they enrolled in the same report as the host, keyed under its
  // `/guest/` prefix). No new endpoint, no wire change, and `infra:read` covers both reads.
  const { data: foundDetail } = useInfraNodeDetail(found?.id ?? null);
  const hypervisor = useMemo(
    () => (foundDetail ? hypervisorFacetOf(foundDetail.specs) : null),
    [foundDetail],
  );
  const pendingGuests = useMemo(
    () => (found ? countPendingGuests(found.externalId, pending ?? []) : 0),
    [found, pending],
  );

  useEffect(() => {
    if (!pending) return;
    // Children are excluded from the match on BOTH child namespaces: Docker containers (#1139) and
    // ADR-0095 hypervisor guests (#1225) ride the same request as the host that reports them, and
    // the list is newest-first — without this a Proxmox install would celebrate `vm-101` as the
    // server the operator just stood up. The children are still in the tray; the guest ones are
    // what the detection callout below counts.
    const agentPending = pending.filter(
      (node) =>
        node.source === "AGENT" &&
        !isContainerChildExternalId(node.externalId) &&
        !isGuestChildExternalId(node.externalId),
    );
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

          {/* The host's first report carried the ADR-0095 facet: say what was detected and where
              its guests went (#1225). Rendered only on a positive facet — a plain server's
              celebration is unchanged. The count can be 0 (a vetoed host, an idle hypervisor);
              the copy stays honest and the review CTA only shows when there is something to
              review. The link lands on the Servers view, which hosts the Pending review tray,
              and closes the wizard on the way out. */}
          {hypervisor ? (
            <Callout
              tone="info"
              icon={<ServerStackIcon />}
              className="rounded-lg text-left text-sm"
            >
              <p>
                {(() => {
                  const label = hypervisorPlatformLabel(hypervisor.platform);
                  const platform = label
                    ? `${label}${hypervisor.version ? ` ${hypervisor.version}` : ""}`
                    : null;
                  return platform
                    ? t("detected.summary", { platform, count: pendingGuests })
                    : t("detected.summaryNoPlatform", { count: pendingGuests });
                })()}
              </p>
              {pendingGuests > 0 ? (
                <p className="mt-1">
                  <Link
                    href="/assets/diagram?view=table"
                    onClick={onClose}
                    className="font-medium underline underline-offset-4"
                  >
                    {t("detected.review")}
                  </Link>
                </p>
              ) : null}
            </Callout>
          ) : null}
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
