"use client";

import { KeyIcon, QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import type { AgentOsFamily } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Callout } from "@/components/callout";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
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
  agentDiagnosticsCommand,
  agentUpdateCommand,
} from "@/lib/agent/install-commands";
import {
  agentPlatformIsAmbiguous,
  agentPlatformsFor,
} from "@/lib/agent/fleet";

/**
 * The command that updates ONE host, and the two sentences an operator needs beside it (ADR-0094
 * §5/§6/§7, issue #1207).
 *
 * Rendered only for a host that is genuinely behind — the gate lives in the fleet view, following
 * ADR-0084 §5's only-when-actionable posture. There is no disabled "Update" on a current host and no
 * "you're up to date, but here's the command anyway".
 *
 * The things stated rather than implied:
 *
 *  - **No token, no URL, nothing to fill in.** `--upgrade` re-runs the host from the configuration
 *    it already holds (#1208), so an operator who scans the line for a `--token` and does not find
 *    one is told why in the same breath. This is also the SAFE form: the earlier command pinned
 *    `--url` to the admin's browser origin, which on an ADR-0087 `lan` instance re-pointed every
 *    host it was pasted on.
 *  - **Do not export `LAZYIT_TOKEN` for it.** That was the old advice and it is now a hard error:
 *    `--upgrade` refuses to share a run with any other credential source, on purpose, so that a
 *    stale exported token can never quietly win over the one the host is actually using.
 *  - **The internal-CA caveat.** `--upgrade` re-uses this host's `LAZYIT_CA_FILE`, but the
 *    `curl`/`irm` that fetches the script runs first and is not covered by it. Pre-existing and
 *    unchanged — the install command had the same first hop — and stated rather than discovered.
 *  - **Both commands when the platform is unknown.** A node whose reported OS family is absent, or
 *    is one lazyit builds no agent for, gets both with a note. Handing a PowerShell line to a Debian
 *    box is the wizard bug #1168 already fixed once, and guessing costs the operator a failed paste
 *    on a host they are already logged into.
 */

/** Where an operator mints a token for a host that has no readable config left. */
const SERVICE_ACCOUNTS_HREF = "/settings/service-accounts";

/** A copyable command — the `font-mono` block + the shared copy affordance, as the wizard prints it. */
export function AgentCommandBlock({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const t = useTranslations("infra.fleet");
  return (
    <div className={className}>
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
    </div>
  );
}

/**
 * The credential line — ADR-0094 §6 as #1208 resolved it, in the place an operator would otherwise
 * go looking for a flag that does not exist.
 *
 * The lost-token route is the load-bearing part. It used to send an operator who no longer holds a
 * host's token straight to *"mint or rotate one"* — and `rotate` INVALIDATES the existing secret, so
 * on the fleet this very view is designed for (one shared `infra:report` account across the estate)
 * that one click silently stops every other host reporting. The host already holds a working
 * credential, so `--upgrade` is the answer, and minting is named only for the case that genuinely
 * has no readable config — with the blast radius of rotating said out loud.
 */
function CredentialNote() {
  const t = useTranslations("infra.fleet");
  return (
    <Callout tone="info" icon={<KeyIcon />}>
      <p>{t("command.credentialNote")}</p>
      <p className="mt-1">
        {t.rich("command.tokenLost", {
          link: (chunks) => (
            <Link href={SERVICE_ACCOUNTS_HREF} className="underline underline-offset-4">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </Callout>
  );
}

/**
 * Every command for one host: the update itself per applicable platform, and the read-only
 * `lazyit-agent test` to run afterwards. `osFamily` drives which platforms appear — evidence only,
 * never a guess ({@link agentPlatformsFor}).
 */
export function AgentUpdateCommands({
  osFamily,
  origin,
}: {
  osFamily: AgentOsFamily | null;
  origin: string;
}) {
  const t = useTranslations("infra.fleet");
  const platforms = agentPlatformsFor(osFamily);
  const ambiguous = agentPlatformIsAmbiguous(osFamily);

  return (
    <div className="space-y-4">
      <CredentialNote />

      {ambiguous ? (
        <Callout tone="warning" icon={<QuestionMarkCircleIcon />}>
          {t("command.unknownOs")}
        </Callout>
      ) : null}

      {platforms.map((platform) => (
        <div key={platform} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t(`platform.${platform}`)}</Badge>
            {platform === "windows" ? (
              <span className="text-xs text-muted-foreground">
                {t("command.windowsElevated")}
              </span>
            ) : null}
          </div>
          <AgentCommandBlock command={agentUpdateCommand(platform, origin)} />
          <p className="text-xs text-muted-foreground">
            {t("command.verify")}
          </p>
          <AgentCommandBlock command={agentDiagnosticsCommand(platform)} />
        </div>
      ))}

      <p className="text-xs text-muted-foreground">{t("command.rerunSafe")}</p>
      {/*
        Pre-existing and unchanged, but now the only argument the command does NOT carry that a host
        might still need: `--upgrade` re-uses this host's LAZYIT_CA_FILE for the agent's own traffic,
        while the curl/irm above fetches the script before any config is read.
      */}
      <p className="text-xs text-muted-foreground">{t("command.internalCa")}</p>
    </div>
  );
}

/**
 * The per-host payoff: one dialog, opened from the row, holding exactly the commands that host
 * needs. A dialog rather than an inline expansion because the block is three commands and a callout
 * tall, and a table where every row can grow by that much stops being scannable — which is the one
 * thing this table is for.
 */
export function AgentUpdateDialog({
  host,
  osFamily,
  origin,
  agentVersion,
  serverVersion,
  open,
  onOpenChange,
}: {
  host: string;
  osFamily: AgentOsFamily | null;
  origin: string;
  agentVersion: string | null;
  serverVersion: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("infra.fleet");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("command.title", { host })}</DialogTitle>
          <DialogDescription>
            {t("command.subtitle", {
              agentVersion: agentVersion ?? t("versionUnknownShort"),
              serverVersion,
            })}
          </DialogDescription>
        </DialogHeader>

        <AgentUpdateCommands osFamily={osFamily} origin={origin} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("command.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
