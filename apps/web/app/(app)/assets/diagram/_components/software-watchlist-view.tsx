"use client";

import {
  ArrowPathIcon,
  CommandLineIcon,
  InformationCircleIcon,
  ShieldExclamationIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  SOFTWARE_WATCH_LIMIT,
  type SoftwareWatchHost,
  type SoftwareWatchPresence,
  type SoftwareWatchSummary,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { ErrorState, Pagination } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  judgeWatchName,
  type SoftwareWatchBucket,
  softwareWatchBucketCount,
  softwareWatchBucketKey,
  softwareWatchNodeHref,
  softwareWatchPresenceSegments,
  softwareWatchVisibleVersions,
} from "@/lib/agent/software-watch";
import { ApiError } from "@/lib/api/client";
import {
  useCreateSoftwareWatch,
  useDeleteSoftwareWatch,
  useSoftwareWatches,
  useSoftwareWatchHosts,
} from "@/lib/api/hooks/use-software-watches";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";

/**
 * Topology › Agents › Software watchlist (#1684, epic #1146 item 4) — *"openssl: 11 hosts on 3.0.13,
 * 2 on 1.1.1w, 1 missing, 3 unknown"*, for each of the handful of packages the team watches.
 *
 * DISTRIBUTION ONLY (CEO decision Q12 on #1146): package → versions → host counts, plus the hosts
 * missing it. No "outdated", no EOL flag, no CVE match, and the version buckets are shown in the order
 * the API sends them — by host count — with a line saying so, because any other order would read as
 * a version ranking.
 *
 * UNKNOWN is never MISSING. A host that stores no package list (software collection off at any policy
 * scope, the host's local veto, or nothing collected yet) or whose policy excludes the name has its
 * own count, its own segment of the bar and, on the drill-in, its own reason per host.
 *
 * Reads ride the Topology screen's `infra:read`. Add and remove need `infra:manage` and are
 * human-only on the API; the web session is always a person, so `infra:manage` is the gate the UI can
 * see, and a 403 from the human-only guard is still reported in words rather than as a crash.
 */

/** How many version buckets a watch shows before "show all". */
const VERSION_PREVIEW = 8;

/** The bar's segment fills — theme tokens only; UNKNOWN is hatched so it never reads as MISSING. */
const SEGMENT_CLASS: Record<SoftwareWatchPresence, string> = {
  INSTALLED: "bg-pillar-inventory",
  MISSING: "bg-foreground/60",
  UNKNOWN:
    "bg-[repeating-linear-gradient(135deg,var(--muted-foreground)_0_2px,transparent_2px_6px)] opacity-60",
};

const PRESENCES: readonly SoftwareWatchPresence[] = ["INSTALLED", "MISSING", "UNKNOWN"];

interface OpenDrillIn {
  watch: SoftwareWatchSummary;
  bucket: SoftwareWatchBucket;
}

export function SoftwareWatchlistView() {
  const t = useTranslations("infra.software");
  const canManage = useCan("infra:manage");
  const { data, isLoading, isError, error, refetch, isFetching } = useSoftwareWatches();
  const [drillIn, setDrillIn] = useState<OpenDrillIn | null>(null);

  if (isLoading) return <WatchlistSkeleton />;
  if (isError || !data) {
    return <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <p className="max-w-3xl text-xs text-muted-foreground">{t("intro")}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <ArrowPathIcon
              className={isFetching ? "motion-safe:animate-spin" : undefined}
              aria-hidden
            />
            {t("refresh")}
          </Button>
        </div>
        <Callout tone="warning" icon={<ShieldExclamationIcon />}>
          <p className="text-sm">
            {t.rich("sensitive", {
              link: (chunks) => (
                <Link
                  href="/help/assets-topology-reporting-agent"
                  className="underline underline-offset-4"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </Callout>
        {canManage ? <AddWatchForm watches={data} /> : null}
      </section>

      {data.length === 0 ? (
        <EmptyState
          icon={CommandLineIcon}
          pillar="inventory"
          title={t("empty.title")}
          description={canManage ? t("empty.description") : t("empty.descriptionReadOnly")}
        />
      ) : (
        <ul className="space-y-4">
          {data.map((watch) => (
            <li key={watch.id}>
              <WatchCard
                watch={watch}
                canManage={canManage}
                onOpen={(bucket) => setDrillIn({ watch, bucket })}
              />
            </li>
          ))}
        </ul>
      )}

      {drillIn ? (
        <HostsDialog
          // Remount per watch+bucket so the paged query's placeholder never shows another
          // bucket's hosts under this bucket's heading.
          key={`${drillIn.watch.id}:${softwareWatchBucketKey(drillIn.bucket)}`}
          watch={drillIn.watch}
          bucket={drillIn.bucket}
          onClose={() => setDrillIn(null)}
        />
      ) : null}
    </div>
  );
}

/** Add a name. The verdict is decided before sending; the API's 409 / 400 stay the real gate. */
function AddWatchForm({ watches }: { watches: readonly SoftwareWatchSummary[] }) {
  const t = useTranslations("infra.software.add");
  const [name, setName] = useState("");
  const create = useCreateSoftwareWatch();
  const verdict = judgeWatchName(name, watches);
  const atLimit = watches.length >= SOFTWARE_WATCH_LIMIT;

  const message =
    verdict.state === "duplicate"
      ? t("duplicate", { name: verdict.normalized })
      : verdict.state === "invalid"
        ? t("invalid")
        : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (verdict.state !== "ok") return;
    create.mutate(
      { name: verdict.normalized },
      {
        onSuccess: (watch) => {
          toast.success(t("added", { name: watch.name }));
          setName("");
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            toast.error(t("duplicate", { name: verdict.normalized }));
          } else if (error instanceof ApiError && error.status === 403) {
            toast.error(t("forbidden"));
          } else {
            notifyError(error, t("error"));
          }
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field data-invalid={message ? true : undefined}>
        <FieldLabel htmlFor="software-watch-name">{t("label")}</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="software-watch-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("placeholder")}
            autoComplete="off"
            spellCheck={false}
            disabled={atLimit}
            aria-invalid={message ? true : undefined}
            className="font-mono sm:max-w-sm"
          />
          <Button type="submit" disabled={verdict.state !== "ok" || create.isPending}>
            {t("submit")}
          </Button>
        </div>
        {message ? <FieldError>{message}</FieldError> : null}
        {verdict.state === "ok" && verdict.normalized !== name ? (
          <FieldDescription>
            {t.rich("normalized", {
              name: verdict.normalized,
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </FieldDescription>
        ) : null}
        <FieldDescription>
          {atLimit
            ? t("limit", { limit: SOFTWARE_WATCH_LIMIT })
            : t("help", { count: watches.length, limit: SOFTWARE_WATCH_LIMIT })}
        </FieldDescription>
      </Field>
    </form>
  );
}

/** One watch: who added it, the presence bar and counts, and the version buckets. */
function WatchCard({
  watch,
  canManage,
  onOpen,
}: {
  watch: SoftwareWatchSummary;
  canManage: boolean;
  onOpen: (bucket: SoftwareWatchBucket) => void;
}) {
  const t = useTranslations("infra.software");
  const { dateTime } = useFormatters();
  const remove = useDeleteSoftwareWatch();
  const [showAll, setShowAll] = useState(false);
  const d = watch.distribution;
  const segments = softwareWatchPresenceSegments(d);
  const { shown, hidden } = softwareWatchVisibleVersions(
    d,
    showAll ? d.versions.length : VERSION_PREVIEW,
  );

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={watch.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="break-all font-mono text-sm font-semibold">{watch.name}</h3>
          <p className="text-xs text-muted-foreground">
            {watch.createdByName
              ? t("watch.addedBy", { name: watch.createdByName, date: dateTime(watch.createdAt) })
              : t("watch.added", { date: dateTime(watch.createdAt) })}
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            aria-label={t("remove.label", { name: watch.name })}
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(watch.id, {
                onSuccess: () => toast.success(t("remove.removed", { name: watch.name })),
                onError: (error) =>
                  error instanceof ApiError && error.status === 403
                    ? toast.error(t("add.forbidden"))
                    : notifyError(error, t("remove.error")),
              })
            }
          >
            <TrashIcon />
          </Button>
        ) : null}
      </div>

      {d.hostsTotal === 0 ? (
        <p className="text-sm text-muted-foreground">{t("watch.noHosts")}</p>
      ) : (
        <>
          <div>
            <p className="text-xs text-muted-foreground">
              {t("watch.hostsTotal", { count: d.hostsTotal })}
            </p>
            {/* Decorative: the same three numbers are the buttons right below it. */}
            <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              {segments.map((segment) => (
                <div
                  key={segment.presence}
                  className={SEGMENT_CLASS[segment.presence]}
                  style={{ width: `${segment.percent}%` }}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {PRESENCES.map((presence) => {
              const count = softwareWatchBucketCount(d, { kind: "presence", presence });
              return (
                <Button
                  key={presence}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={count === 0}
                  onClick={() => onOpen({ kind: "presence", presence })}
                >
                  <span
                    className={cn("size-2 shrink-0 rounded-full", SEGMENT_CLASS[presence])}
                    aria-hidden
                  />
                  <span className="font-mono tabular-nums">{count}</span>
                  <span>{t(`presence.${presence}`)}</span>
                </Button>
              );
            })}
          </div>

          {d.unknown > 0 ? (
            <p className="flex gap-2 text-xs text-muted-foreground">
              <InformationCircleIcon className="mt-px size-4 shrink-0" aria-hidden />
              <span>{t("watch.unknownNote", { count: d.unknown })}</span>
            </p>
          ) : null}

          {d.versions.length > 0 ? (
            <div className="space-y-1">
              <h4 className="text-xs font-medium">{t("watch.versionsTitle")}</h4>
              <p className="text-xs text-muted-foreground">{t("watch.versionsNote")}</p>
              <ul className="divide-y rounded-md border">
                {shown.map((entry) => (
                  <li
                    key={entry.version ?? "\u0000null"}
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                  >
                    <span
                      className={cn(
                        "min-w-0 break-all text-sm",
                        entry.version === null ? "text-muted-foreground italic" : "font-mono",
                      )}
                    >
                      {entry.version ?? t("watch.noVersion")}
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto shrink-0 p-0 tabular-nums"
                      onClick={() => onOpen({ kind: "version", version: entry.version })}
                    >
                      {t("watch.hosts", { count: entry.hosts })}
                    </Button>
                  </li>
                ))}
              </ul>
              {hidden > 0 || showAll ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll
                    ? t("watch.showFewer")
                    : t("watch.showAll", { count: d.versions.length })}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The hosts behind one bucket, paged, each linking to its node. */
function HostsDialog({
  watch,
  bucket,
  onClose,
}: {
  watch: SoftwareWatchSummary;
  bucket: SoftwareWatchBucket;
  onClose: () => void;
}) {
  const t = useTranslations("infra.software.hosts");
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, error, refetch, isFetching } = useSoftwareWatchHosts(
    watch.id,
    bucket,
    offset,
  );
  const expected = softwareWatchBucketCount(watch.distribution, bucket);
  const bucketLabel =
    bucket.kind === "presence"
      ? t(`bucket.${bucket.presence}`)
      : bucket.version === null
        ? t("bucketNoVersion")
        : t("bucketVersion", { version: bucket.version });
  const items = data?.items ?? [];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">
            <span className="font-mono">{watch.name}</span> · {bucketLabel}
          </DialogTitle>
          <DialogDescription>
            {t("description", { count: data?.total ?? expected })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            {["a", "b", "c"].map((key) => (
              <Skeleton key={key} className="h-10 w-full" />
            ))}
          </div>
        ) : isError || !data ? (
          <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="space-y-3">
            <ul className="divide-y rounded-md border">
              {items.map((host) => (
                <HostRow key={host.id} host={host} />
              ))}
            </ul>
            <Pagination
              total={data.total}
              limit={data.limit}
              offset={data.offset}
              itemCount={items.length}
              onOffsetChange={setOffset}
              isFetching={isFetching}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HostRow({ host }: { host: SoftwareWatchHost }) {
  const t = useTranslations("infra.software.hosts");
  const { relative, dateTime } = useFormatters();

  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={softwareWatchNodeHref(host.id)}
          className="text-sm font-medium hover:underline"
        >
          {host.label}
        </Link>
        {host.pending ? <Badge variant="outline">{t("flags.pending")}</Badge> : null}
        {host.status === "OFFLINE" ? (
          <StatusBadge tone="warning">{t("flags.offline")}</StatusBadge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {host.presence === "INSTALLED" ? (
          <span className="font-mono">
            {host.versions.map((version) => version ?? t("noVersion")).join(", ")}
          </span>
        ) : host.presence === "MISSING" ? (
          t("missingDetail")
        ) : (
          t(`reason.${host.unknownReason ?? "NOT_COLLECTED"}`)
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {host.inventoryCollectedAt ? (
          <span title={dateTime(host.inventoryCollectedAt)}>
            {t("collected", { time: relative(host.inventoryCollectedAt) })}
          </span>
        ) : host.lastReportedAt ? (
          <span title={dateTime(host.lastReportedAt)}>
            {t("lastReport", { time: relative(host.lastReportedAt) })}
          </span>
        ) : (
          t("neverReported")
        )}
      </p>
    </li>
  );
}

function WatchlistSkeleton() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-2 h-3 w-full max-w-xl" />
        <Skeleton className="mt-4 h-9 w-full max-w-sm" />
      </div>
      {["a", "b"].map((key) => (
        <div key={key} className="space-y-3 rounded-lg border p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-2 w-full rounded-full" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}
