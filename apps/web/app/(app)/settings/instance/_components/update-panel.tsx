"use client";

import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpCircleIcon,
  ShieldExclamationIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import type { UpdateRun, UpdateRunStatus } from "@lazyit/shared";
import { isActiveUpdateRun } from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { SettingRow, SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { notifyError } from "@/lib/api/notify-error";
import {
  useCancelUpdate,
  useEnqueueUpdate,
  useUpdateSettings,
  useUpdateStatus,
  useUpdateUpdateSettings,
} from "@/lib/api/hooks/use-instance-version";
import { useSmtpSettings } from "@/lib/api/hooks/use-smtp-settings";

/** A label / value row inside the card (mirrors the InfoRow in instance-settings-view). */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
}

/** The presentation tone for a run status (terminal states colored; in-flight neutral/info). */
function runTone(status: UpdateRunStatus): StatusTone {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "rolled_back":
      return "warning";
    default:
      return "info";
  }
}

/**
 * Settings → General & version: the "Version & updates" section (ADR-0084 §5). The FIRST section on
 * the page; its status badge sits in the section header (#1533). Shows the
 * running version, whether a newer release is out ("N behind" / up to date / checks off / couldn't
 * check), the opt-in weekly-check toggle, the singular oxblood "update" CTA (rendered ONLY when behind),
 * the guided-update command + honest in-progress stage labels from the real UpdateRun phases, and the
 * run history. It NEVER runs an update — clicking the CTA only enqueues an UpdateRun and reveals the
 * exact `./infra/update.sh vX.Y.Z` command the operator runs on the host.
 */
export function UpdatePanel() {
  const t = useTranslations("settings.instance.updates");
  const { dateTime } = useFormatters();
  const status = useUpdateStatus();
  const settings = useUpdateSettings();
  const smtp = useSmtpSettings();
  const toggle = useUpdateUpdateSettings();
  const enqueue = useEnqueueUpdate();
  const cancel = useCancelUpdate();

  const data = status.data;
  const checkEnabled = settings.data?.checkEnabled ?? false;
  const smtpConfigured = smtp.data?.enabled ?? false;
  const activeRun = data?.activeRun ?? null;
  const behindBy = data?.behindBy ?? 0;
  const isBehind = behindBy > 0 && !!data?.latestVersion;
  // A security-relevant gap (issue #908) — a distinct, louder badge + a callout that says click-now.
  const isSecurity = isBehind && (data?.securityRelevant ?? false);
  const runInFlight = !!activeRun && isActiveUpdateRun(activeRun.status);

  // The command the operator runs on the host once a run is enqueued (ADR-0084 §4).
  const commandTarget = activeRun?.toVersion ?? data?.latestVersion ?? "";
  const command = commandTarget ? `./infra/update.sh ${commandTarget}` : "";

  function onToggle(next: boolean) {
    toggle.mutate(
      { checkEnabled: next },
      { onError: (err) => notifyError(err, t("optIn.label")) },
    );
  }

  function onEnqueue() {
    if (!data?.latestVersion) return;
    enqueue.mutate(
      { toVersion: data.latestVersion },
      {
        onSuccess: () => toast.success(t("toast.enqueued")),
        onError: (err) => notifyError(err, t("cta.hint")),
      },
    );
  }

  function onCancel() {
    cancel.mutate(undefined, {
      onSuccess: () => toast.success(t("cancel.toast")),
      onError: (err) => notifyError(err, t("cancel.button")),
    });
  }

  // The headline status badge.
  const statusBadge = (() => {
    if (!checkEnabled)
      return (
        <StatusBadge tone="neutral" dot>
          {t("state.checksOff")}
        </StatusBadge>
      );
    if (!data?.latestVersion)
      return (
        <StatusBadge tone="neutral" dot>
          {t("state.notChecked")}
        </StatusBadge>
      );
    if (isSecurity)
      return (
        <StatusBadge tone="danger" dot>
          {t("state.securityBehind", { count: behindBy })}
        </StatusBadge>
      );
    if (isBehind)
      return (
        <StatusBadge tone="warning" dot>
          {t("state.behind", { count: behindBy })}
        </StatusBadge>
      );
    return (
      <StatusBadge tone="success" dot>
        {t("state.upToDate")}
      </StatusBadge>
    );
  })();

  return (
    <SettingsSection
      title={t("title")}
      summary={t("subtitle")}
      status={status.isLoading ? null : statusBadge}
    >
        {status.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="divide-y">
              <InfoRow label={t("rows.current")}>
                <span className="font-mono text-xs">
                  {data?.currentVersion ?? "—"}
                </span>
              </InfoRow>
              {checkEnabled && (
                <>
                  <InfoRow label={t("rows.latest")}>
                    {data?.latestVersion ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono text-xs">
                          {data.latestVersion}
                        </span>
                        {data.htmlUrl && (
                          <a
                            href={data.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t("rows.viewRelease")}
                          >
                            <ArrowTopRightOnSquareIcon className="size-3.5" />
                          </a>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </InfoRow>
                  <InfoRow label={t("rows.lastChecked")}>
                    {data?.checkedAt ? (
                      dateTime(data.checkedAt)
                    ) : (
                      <span className="text-muted-foreground">
                        {t("rows.never")}
                      </span>
                    )}
                  </InfoRow>
                </>
              )}
            </div>

            {/* Opt-in weekly check toggle — a standalone switch that autosaves, as it always has. */}
            <div className="border-t pt-3">
              <SettingRow
                label={t("optIn.label")}
                htmlFor="update-check-enabled"
                help={<p>{t("optIn.description")}</p>}
                note={
                  checkEnabled && !smtpConfigured
                    ? t.rich("optIn.smtpHint", {
                        link: (chunks) => (
                          <Link
                            href="/settings/email"
                            className="font-medium text-foreground underline underline-offset-4"
                          >
                            {chunks}
                          </Link>
                        ),
                      })
                    : undefined
                }
              >
                <Switch
                  id="update-check-enabled"
                  checked={checkEnabled}
                  onCheckedChange={onToggle}
                  disabled={toggle.isPending || settings.isLoading}
                />
              </SettingRow>
            </div>

            {/* In-progress run: honest stage label + reconnecting note (no fake progress bar). */}
            {runInFlight && activeRun && (
              <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-center gap-2">
                  <ArrowPathIcon className="size-4 animate-spin text-primary" />
                  <p className="text-sm font-medium">
                    {t(`runStatus.${activeRun.status}`)}
                  </p>
                </div>
                {activeRun.status === "requested" ? (
                  <div className="space-y-2.5">
                    <p className="text-xs text-muted-foreground">
                      {t("command.instruction")}
                    </p>
                    <code className="block rounded bg-muted px-2 py-1.5 font-mono text-xs">
                      {command}
                    </code>
                    <div className="space-y-1.5 border-t border-primary/20 pt-2.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onCancel}
                        disabled={cancel.isPending}
                      >
                        <XCircleIcon />
                        {t("cancel.button")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("cancel.hint")}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("command.reconnecting")}
                  </p>
                )}
              </div>
            )}

            {/* Security emphasis (issue #908): a distinct danger-toned callout when the gap contains a
                security-marked release, so the update reads as click-now rather than schedule-for-later. */}
            {isSecurity && !runInFlight && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <ShieldExclamationIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-destructive">
                    {t("security.title")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("security.description")}
                  </p>
                </div>
              </div>
            )}

            {/* The singular oxblood CTA — ONLY when behind and no run is in flight (§5). */}
            {isBehind && !runInFlight && (
              <div className="space-y-2">
                <Button
                  variant="default"
                  onClick={onEnqueue}
                  disabled={enqueue.isPending}
                >
                  <ArrowUpCircleIcon />
                  {t("cta.update", { version: data?.latestVersion ?? "" })}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t("cta.hint")}
                </p>
              </div>
            )}

            {/* Run history. */}
            {data && data.recentRuns.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("history.title")}
                </p>
                <ul className="divide-y rounded-lg border">
                  {data.recentRuns.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      label={t(`runStatus.${run.status}`)}
                      when={dateTime(run.createdAt)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
    </SettingsSection>
  );
}

/** One row in the update history list. */
function RunRow({
  run,
  label,
  when,
}: {
  run: UpdateRun;
  label: string;
  when: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 font-mono text-xs">
        {run.fromVersion} → {run.toVersion}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">{when}</span>
        <StatusBadge tone={runTone(run.status)}>{label}</StatusBadge>
      </span>
    </li>
  );
}
