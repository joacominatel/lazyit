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
  agentTokenEnvVar,
  agentUpdateCommand,
  type AgentPlatform,
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
 * The two things stated rather than implied:
 *
 *  - **No token.** The server cannot re-emit an installed host's secret; only `tokenHash` and
 *    `tokenPrefix` are stored. The command names the environment variable both installers already
 *    read, so an operator who scans the line for a `--token` and does not find one is told why in
 *    the same breath — and pointed at the service-account screen if they no longer hold it.
 *  - **Both commands when the platform is unknown.** A node whose reported OS family is absent, or
 *    is one lazyit builds no agent for, gets both with a note. Handing a PowerShell line to a Debian
 *    box is the wizard bug #1168 already fixed once, and guessing costs the operator a failed paste
 *    on a host they are already logged into.
 */

/** Where an operator mints or rotates a token when they no longer hold this host's. */
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
 * The token line — the whole of ADR-0094 §6, in the place an operator would otherwise go looking for
 * a flag that does not exist. Names the variable in the spelling the platform's own installer reads
 * it under, and links to where a lost token is replaced rather than reimplementing that flow.
 */
function TokenNote({ platforms }: { platforms: readonly AgentPlatform[] }) {
  const t = useTranslations("infra.fleet");
  return (
    <Callout tone="info" icon={<KeyIcon />}>
      <p>
        {t("command.tokenNote", {
          variables: platforms.map((platform) => agentTokenEnvVar(platform)).join(" / "),
        })}
      </p>
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
      <TokenNote platforms={platforms} />

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
