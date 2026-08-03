"use client";

import { ClockIcon } from "@heroicons/react/24/outline";
import type { InfraFactChangeKind } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useInfraNodeChanges } from "@/lib/api/hooks/use-infra-nodes";

/**
 * The Changes tab (ADR-0074 §3 amendment, #1143) — the node's recorded fact history, newest first.
 *
 * It is the surface behind *"someone upgraded OpenSSL on db-01 last Tuesday and broke the app."* Every
 * other tab shows the CURRENT value of a fact; this one shows the moments it moved. It is read-only
 * and always is: only the reporting agent's ingest path appends to this table, and the table is
 * append-only, so there is nothing here for an operator to edit or delete.
 *
 * `active` is the detail modal's open tab, forwarded to the query's `enabled`: opening a node fetches
 * nothing until the operator asks for this tab. It is passed explicitly rather than inferred from the
 * tab primitive unmounting its inactive content, so the gate is this file's guarantee and not a
 * library default a later `forceMount` could quietly remove.
 */
export function NodeChangesTab({
  nodeId,
  active,
}: {
  nodeId: string;
  /** Whether the Changes tab is the one currently open. */
  active: boolean;
}) {
  const t = useTranslations("infra");
  const { dateTime, relative } = useFormatters();
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfraNodeChanges(nodeId, active);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title={t("changes.loadError")}
        description={t("error.description")}
        onRetry={() => refetch()}
        error={error}
      />
    );
  }

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        icon={ClockIcon}
        title={t("changes.emptyTitle")}
        description={t("changes.emptyDescription")}
      />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.map((change) => (
          <li
            key={change.id}
            className="rounded-lg border p-3 text-sm"
            // The absolute timestamp rides as a title so the relative label stays readable while the
            // exact moment — the thing an operator correlates an outage against — is one hover away.
            title={dateTime(change.createdAt)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant="secondary">
                  {t(`changes.kind.${change.kind}`)}
                </Badge>
                <span className="truncate font-mono text-xs">
                  {factLabel(change.fact, t)}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {relative(change.createdAt)}
              </span>
            </div>
            <ChangeValues
              kind={change.kind}
              previousValue={change.previousValue}
              currentValue={change.currentValue}
            />
          </li>
        ))}
      </ul>
      {hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? t("changes.loadingMore") : t("changes.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The before/after line. Both sides are legitimately absent on some kinds — an install has no
 * previous version, a removal no current one, and a package listed without a version has neither on
 * the side that lacked it — so each is rendered only when it is there, and a row with neither (a
 * package that moved between "installed, version unknown" states) shows no line at all rather than a
 * pair of dashes pretending to be data.
 */
function ChangeValues({
  kind,
  previousValue,
  currentValue,
}: {
  kind: InfraFactChangeKind;
  previousValue: string | null;
  currentValue: string | null;
}) {
  if (previousValue === null && currentValue === null) return null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-xs">
      {previousValue !== null ? (
        <span
          className={
            kind === "PACKAGE_REMOVED"
              ? "text-muted-foreground line-through"
              : "text-muted-foreground"
          }
        >
          {previousValue}
        </span>
      ) : null}
      {previousValue !== null && currentValue !== null ? (
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
      ) : null}
      {currentValue !== null ? <span>{currentValue}</span> : null}
    </p>
  );
}

/**
 * The tracked host/container fact keys the server records, mapped to their message key.
 *
 * Anything NOT in this map renders VERBATIM, which is the point: a package name is a `fact` too, and
 * so is a fact key a newer server learned to record and this build has never heard of. Falling back to
 * the stored string keeps both readable instead of showing a missing-translation marker — the same
 * degrade-never-reject posture the report contract itself is built on.
 */
const FACT_MESSAGE_KEYS: Record<string, string> = {
  "host.os.name": "hostOsName",
  "host.os.version": "hostOsVersion",
  "host.os.kernel": "hostOsKernel",
  "host.memoryBytes": "hostMemoryBytes",
  "host.disks.totalBytes": "hostDisksTotalBytes",
  "host.disks.count": "hostDisksCount",
  "host.hardware.serial": "hostHardwareSerial",
  "container.image": "containerImage",
  "container.imageDigest": "containerImageDigest",
};

function factLabel(fact: string, t: (key: string) => string): string {
  const key = FACT_MESSAGE_KEYS[fact];
  return key ? t(`changes.facts.${key}`) : fact;
}
