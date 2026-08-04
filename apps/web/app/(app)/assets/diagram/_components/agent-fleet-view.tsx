"use client";

import {
  ArrowPathIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import {
  type AgentFleetIdentity,
  type AgentFleetNode,
  type AgentFleetSummary,
  type AgentVersionBucket,
  summarizeAgentFleet,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import {
  ErrorState,
  LinkableRow,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
} from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableCell } from "@/components/ui/table";
import { useAgentFleet } from "@/lib/api/hooks/use-agent-fleet";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useListParams } from "@/lib/hooks/use-list-params";
import {
  AGENT_FLEET_FILTERS,
  type AgentFleetFilter,
  agentFleetCredentialBlock,
  agentFleetFilterFromParam,
  agentFleetUpdateGroups,
  agentFleetUpdateScript,
  filterAgentFleetNodes,
  isAgentUpdatable,
  isNotReportingNode,
} from "@/lib/agent/fleet";
import { AgentCommandBlock, AgentUpdateDialog } from "./agent-update-command";

/**
 * Topology › Agents (ADR-0094 §4/§8, issue #1207) — *"how many agents do I have, on what versions,
 * who has not checked in, and who is degraded?"*, and for every host that is behind, the exact
 * command to run.
 *
 * The third view of the one Topology destination (`?view=map|table|agents`), so it inherits the
 * screen's header and its `infra:read` gate, and it is somewhere an admin NAVIGATES TO. That is the
 * whole posture (ADR-0084 §5, restated by ADR-0094 §8): no global banner, no login interrupt, no
 * modal, and the update affordance rendered ONLY for a host that is genuinely behind. The full
 * version distribution sits above the table anyway — **a table you navigated to is not a nag** — and
 * the loud MAJOR-behind tier stays the only one wearing a colour, exactly as the #907 badge does.
 *
 * Everything here renders when the fields are absent, because on the day this ships most of them
 * are. An estate whose agents predate #1203 reports `agentVersion: "dev"` — so every row is "version
 * unknown", the OS family may be missing, and a host that stopped reporting has no timestamp at all.
 * That is the state the view opens on, it is stated rather than papered over ({@link UnknownNote}),
 * and `fleet.test.ts` covers the same path underneath.
 *
 * The summary is re-tallied CLIENT-SIDE over the filtered rows with the shared
 * `summarizeAgentFleet`, so the counts above the table always describe the table below it — and the
 * server and the web can never disagree about what "31 behind" means, because it is one function.
 */

/** The filter's URL param. Named for the view so it cannot collide with the Table's kind/status/state. */
const FILTER_PARAM = "agents";
const FILTER_DEFAULTS = { [FILTER_PARAM]: "ALL" } as const;

/** Stable empty placeholder for the loading skeleton's mobile children slot. */
const LOADING_MOBILE_CHILDREN = <></>;

/** How many never-used identities are named inline before the list defers to Service accounts. */
const IDENTITY_PREVIEW = 6;

/** Where a never-used credential is inspected, rotated or revoked. */
const SERVICE_ACCOUNTS_HREF = "/settings/service-accounts";

/** Only the MAJOR tier is allowed a colour (ADR-0094 §3/§8) — everything else reads as a fact. */
const BUCKET_VARIANT: Record<AgentVersionBucket, "warning" | "outline"> = {
  majorBehind: "warning",
  behind: "outline",
  unknown: "outline",
  current: "outline",
};

export function AgentFleetView() {
  const t = useTranslations("infra.fleet");
  const { data, isLoading, isError, error, refetch, isFetching } = useAgentFleet();
  const { q, filters, setQ, setFilter, clearFilters, filtersActive } = useListParams({
    filters: FILTER_DEFAULTS,
    // A tampered or stale `?agents=` falls back to "ALL" here as well as in
    // `agentFleetFilterFromParam`, so it can never reach `t("filter.<garbage>")` and raise a
    // MISSING_MESSAGE (#944) on its way to being ignored.
    filterValidators: { [FILTER_PARAM]: AGENT_FLEET_FILTERS },
  });
  const filter = agentFleetFilterFromParam(filters[FILTER_PARAM]);

  // The instance the admin is already talking to over this very channel — the wizard's rule, and the
  // only origin that is true for a self-hosted, domain-portable deployment.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://<your-instance>";

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const rows = useMemo(
    () => filterAgentFleetNodes(nodes, { q, filter }),
    [nodes, q, filter],
  );

  if (isLoading) {
    return <FleetSkeleton />;
  }
  if (isError || !data) {
    return <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />;
  }

  // ABSENT, not empty (#1206): a caller without `settings:manage` is not shown the credential
  // inventory at all, so there is nothing here to fall back to a length on.
  const credentials = agentFleetCredentialBlock(data);

  if (nodes.length === 0 && (credentials?.identities.length ?? 0) === 0) {
    return (
      <EmptyState
        icon={CpuChipIcon}
        pillar="inventory"
        title={t("empty.title")}
        description={t("empty.description")}
      />
    );
  }

  // The counts above the table describe the table below it: the whole fleet when nothing is
  // filtered, the filtered set when something is.
  const shown = summarizeAgentFleet(rows);

  return (
    <div className="space-y-6">
      <FleetSummary
        summary={shown}
        total={data.summary.total}
        serverVersion={data.serverVersion}
        filter={filter}
        onFilter={(next) => setFilter(FILTER_PARAM, next)}
        onRefresh={() => void refetch()}
        refreshing={isFetching}
      />

      {/*
        Only-when-actionable (ADR-0084 §5): nothing behind ⇒ no update affordance at all.

        Gated on the FILTERED tally, not the fleet-wide one, so the card's existence and its contents
        describe the same set as the summary immediately above it. It used to be gated on
        `data.summary.behindTotal` and silently swap its payload to the whole fleet when the filter
        left nothing behind — a card headed "3 hosts can be updated" sitting under a summary that had
        just re-tallied to zero, offering commands for hosts the operator had filtered away.
      */}
      {shown.behindTotal > 0 ? (
        <BulkUpdateCard nodes={rows} origin={origin} serverVersion={data.serverVersion} />
      ) : null}

      <UnknownNote unknown={data.summary.unknown} serverVersion={data.serverVersion} />

      {credentials ? (
        <NeverUsedIdentities
          identities={credentials.identities}
          neverUsed={credentials.neverUsed}
        />
      ) : null}

      <FleetTable
        rows={rows}
        q={q}
        setQ={setQ}
        filter={filter}
        setFilter={(next) => setFilter(FILTER_PARAM, next)}
        clearFilters={clearFilters}
        filtersActive={filtersActive}
        origin={origin}
        serverVersion={data.serverVersion}
      />
    </div>
  );
}

/**
 * The distribution (ADR-0094 §8) — *"245 agents · 12 a MAJOR behind · 31 behind · 180 version
 * unknown · 22 not reporting"*. It reads as a summary, not an alarm: every count is a button that
 * filters the table, and only the MAJOR tier carries a tone.
 */
function FleetSummary({
  summary,
  total,
  serverVersion,
  filter,
  onFilter,
  onRefresh,
  refreshing,
}: {
  summary: AgentFleetSummary;
  total: number;
  serverVersion: string;
  filter: AgentFleetFilter;
  onFilter: (next: AgentFleetFilter) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const t = useTranslations("infra.fleet");
  const cells: { key: AgentFleetFilter; value: number; tone: boolean }[] = [
    { key: "majorBehind", value: summary.majorBehind, tone: summary.majorBehind > 0 },
    { key: "behind", value: summary.behind, tone: false },
    { key: "unknown", value: summary.unknown, tone: false },
    { key: "current", value: summary.current, tone: false },
    { key: "notReporting", value: summary.notReporting, tone: false },
    { key: "degraded", value: summary.degraded, tone: false },
  ];

  return (
    <section className="rounded-lg border p-4" aria-label={t("summary.aria")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">
            {t("summary.total", { count: summary.total })}
            {summary.total !== total ? (
              <span className="ml-1 font-normal text-muted-foreground">
                {t("summary.ofTotal", { total })}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("summary.comparedTo", { version: serverVersion })}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <ArrowPathIcon
            className={refreshing ? "motion-safe:animate-spin" : undefined}
            aria-hidden
          />
          {t("summary.refresh")}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {cells.map((cell) => {
          const active = filter === cell.key;
          return (
            <Button
              key={cell.key}
              type="button"
              // The MAJOR tier is the only one allowed a tint, and only when it is non-zero
              // (ADR-0094 §3/§8). The tint rides the button surface, never small coloured text.
              variant={active ? "secondary" : cell.tone ? "warning" : "ghost"}
              size="sm"
              aria-pressed={active}
              onClick={() => onFilter(active ? "ALL" : cell.key)}
            >
              <span className="font-mono tabular-nums">{cell.value}</span>
              <span>{t(`filter.${cell.key}`)}</span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The config-management handoff (ADR-0094 §7) — one command per platform, annotated with which hosts
 * it is for, and a single copy that takes the whole behind-set.
 *
 * Rendered only when something in the CURRENT FILTER is genuinely behind, and its contents are
 * exactly that set — ADR-0094 §7's *"a bulk copy of the generated commands for the current filter"*.
 * An operator who narrowed to "a MAJOR behind" copies the commands for exactly those hosts.
 *
 * There is deliberately no fall back to the whole fleet. It used to have one, and it made the card
 * lie about its own scope: a filter that left nothing updatable swapped the payload to every behind
 * host in the estate, under a summary that had just re-tallied to zero and under a heading counting
 * hosts the table below was not showing. One set, named once, or no card.
 */
function BulkUpdateCard({
  nodes,
  origin,
  serverVersion,
}: {
  nodes: readonly AgentFleetNode[];
  origin: string;
  serverVersion: string;
}) {
  const t = useTranslations("infra.fleet");
  const groups = useMemo(() => agentFleetUpdateGroups(nodes, origin), [nodes, origin]);

  if (groups.length === 0) return null;

  const hostCount = new Set(
    groups.flatMap((group) => group.hosts.map((host) => host.label)),
  ).size;

  const script = agentFleetUpdateScript(groups, {
    headline: t("bulk.scriptHeadline", { count: hostCount, version: serverVersion }),
    credentialNote: t("bulk.scriptCredentialNote"),
    hostsLine: (group) =>
      t("bulk.scriptHosts", {
        platform: group.platform,
        count: group.hosts.length,
        hosts: group.hosts.map((host) => host.label).join(", "),
      }),
  });

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-semibold">{t("bulk.title", { count: hostCount })}</h2>
        <p className="text-xs text-muted-foreground">{t("bulk.subtitle")}</p>
      </div>

      {groups.map((group) => (
        <div key={group.platform} className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t("bulk.groupHosts", {
              platform: t(`platform.${group.platform}`),
              count: group.hosts.length,
            })}
          </p>
          <AgentCommandBlock command={group.command} />
        </div>
      ))}

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("bulk.copyAll")}</p>
        <AgentCommandBlock command={script} />
      </div>
    </section>
  );
}

/**
 * Why most of an estate reads "version unknown" on the day this ships (ADR-0094 §2/§10).
 *
 * Stated, not hidden: agents installed before #1203 report `dev`, which is not comparable, so they
 * are `unknown` rather than "behind" — the fail-soft rule, unchanged. Each host that runs the
 * command once acquires a stamped version and moves into a real bucket. The honest part is that the
 * FIRST of those updates is the one lazyit cannot help with, which is exactly what this note says.
 *
 * A `dev` SERVER makes every bucket unknown for the opposite reason and gets its own line, because
 * otherwise the whole distribution looks broken with no explanation on screen.
 */
function UnknownNote({
  unknown,
  serverVersion,
}: {
  unknown: number;
  serverVersion: string;
}) {
  const t = useTranslations("infra.fleet");
  if (unknown === 0) return null;
  const devServer = serverVersion === "dev";
  return (
    <Callout tone="info" icon={<InformationCircleIcon />}>
      <p className="text-sm">
        {devServer
          ? t("unknownNote.devServer", { count: unknown })
          : t("unknownNote.body", { count: unknown })}
      </p>
      <p className="mt-1 text-sm">
        {t.rich("unknownNote.help", {
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
  );
}

/**
 * The other half of liveness (ADR-0094 §4): a token minted for a host that never checked in leaves
 * NO node behind, so without this the most common install failure is invisible — nothing appears
 * anywhere and the operator concludes the agent works.
 *
 * There is deliberately no claim about WHICH host each credential was for: the schema carries no
 * ServiceAccount→InfraNode link and this ADR adds no column, so this stays a fleet-level list.
 *
 * ADMIN-ONLY, and the caller decides. The credential block rides a second `settings:manage` gate
 * (#1206) and is OMITTED for anyone else, so this component is never rendered without one — see
 * {@link agentFleetCredentialBlock} for why absence is not rendered as an empty list.
 */
function NeverUsedIdentities({
  identities,
  neverUsed,
}: {
  identities: readonly AgentFleetIdentity[];
  neverUsed: number;
}) {
  const t = useTranslations("infra.fleet");
  const { dateTime } = useFormatters();
  if (neverUsed === 0) return null;
  const listed = identities.filter((identity) => identity.lastUsedAt === null);
  const preview = listed.slice(0, IDENTITY_PREVIEW);

  return (
    <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
      <p className="text-sm font-medium">{t("identities.title", { count: neverUsed })}</p>
      <p className="mt-1 text-sm">{t("identities.body")}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {preview.map((identity) => (
          <li key={identity.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{identity.name}</span>
            <span className="text-xs text-muted-foreground">
              {t("identities.created", { date: dateTime(identity.createdAt) })}
            </span>
            {identity.isActive ? null : (
              <Badge variant="outline">{t("identities.disabled")}</Badge>
            )}
          </li>
        ))}
      </ul>
      {listed.length > preview.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("identities.more", { count: listed.length - preview.length })}
        </p>
      ) : null}
      <p className="mt-2 text-sm">
        <Link href={SERVICE_ACCOUNTS_HREF} className="underline underline-offset-4">
          {t("identities.manage")}
        </Link>
      </p>
    </Callout>
  );
}

/** The distribution table itself — the full picture, filterable, with the per-host command on the row. */
function FleetTable({
  rows,
  q,
  setQ,
  filter,
  setFilter,
  clearFilters,
  filtersActive,
  origin,
  serverVersion,
}: {
  rows: readonly AgentFleetNode[];
  q: string;
  setQ: (value: string) => void;
  filter: AgentFleetFilter;
  setFilter: (next: AgentFleetFilter) => void;
  clearFilters: () => void;
  filtersActive: boolean;
  origin: string;
  serverVersion: string;
}) {
  const t = useTranslations("infra.fleet");
  const [openHost, setOpenHost] = useState<string | null>(null);
  const columns = useMemo<ResourceColumn[]>(
    () => [
      { key: "host", header: t("columns.host"), skeleton: <Skeleton className="h-4 w-40" /> },
      {
        key: "version",
        header: t("columns.version"),
        skeleton: <Skeleton className="h-5 w-24 rounded-full" />,
      },
      { key: "os", header: t("columns.os"), skeleton: <Skeleton className="h-4 w-16" /> },
      {
        key: "reported",
        header: t("columns.reported"),
        skeleton: <Skeleton className="h-4 w-24" />,
      },
      {
        key: "actions",
        header: t("columns.actions"),
        srOnlyHeader: true,
        headClassName: "w-28 text-right",
        skeleton: <Skeleton className="h-8 w-20" />,
      },
    ],
    [t],
  );

  const chips = [
    ...(q ? [{ key: "q", label: t("chipSearch", { query: q }), onClear: () => setQ("") }] : []),
    ...(filter !== "ALL"
      ? [
          {
            key: FILTER_PARAM,
            label: t("chipFilter", { filter: t(`filter.${filter}`) }),
            onClear: () => setFilter("ALL"),
          },
        ]
      : []),
  ];

  const open = rows.find((row) => row.id === openHost) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput
          value={q}
          debounceMs={300}
          onDebouncedChange={setQ}
          label={t("searchLabel")}
          placeholder={t("searchPlaceholder")}
          className="sm:max-w-xs sm:flex-1"
        />
        <Select value={filter} onValueChange={(value) => setFilter(agentFleetFilterFromParam(value))}>
          <SelectTrigger className="sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_FLEET_FILTERS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`filter.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtersActive ? <ActiveFilters chips={chips} onClearAll={clearFilters} /> : null}

      <ResourceTable
        columns={columns}
        isFilteredEmpty={rows.length === 0}
        filteredEmptyMessage={t("filteredEmpty")}
        filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
        mobileChildren={rows.map((node) => (
          <ResourceCard
            key={node.id}
            href={nodeHref(node.id)}
            title={node.label}
            badge={<VersionBadge node={node} />}
            meta={
              <>
                <ResourceCardMeta label={t("columns.os")}>
                  <OsCell node={node} />
                </ResourceCardMeta>
                <ResourceCardMeta label={t("columns.reported")}>
                  <ReportedCell node={node} />
                </ResourceCardMeta>
                <ResourceCardMeta label={t("columns.state")} className="col-span-2">
                  <RowFlags node={node} />
                </ResourceCardMeta>
              </>
            }
            actions={
              isAgentUpdatable(node) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenHost(node.id)}
                >
                  {t("updateAction")}
                </Button>
              ) : undefined
            }
          />
        ))}
      >
        {rows.map((node) => (
          <LinkableRow key={node.id} href={nodeHref(node.id)}>
            <TableCell className="font-medium">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={nodeHref(node.id)} className="hover:underline">
                    {node.label}
                  </Link>
                  <RowFlags node={node} />
                </div>
                {node.assetName ? (
                  <p className="text-xs text-muted-foreground">{node.assetName}</p>
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              <VersionBadge node={node} />
            </TableCell>
            <TableCell>
              <OsCell node={node} />
            </TableCell>
            <TableCell>
              <ReportedCell node={node} />
            </TableCell>
            <TableCell className="text-right">
              {/* ADR-0094 §8: the affordance exists only where there is something to do. */}
              {isAgentUpdatable(node) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-row-noclick
                  onClick={() => setOpenHost(node.id)}
                >
                  {t("updateAction")}
                </Button>
              ) : null}
            </TableCell>
          </LinkableRow>
        ))}
      </ResourceTable>

      {open ? (
        <AgentUpdateDialog
          host={open.label}
          osFamily={open.osFamily}
          origin={origin}
          agentVersion={open.agentVersion}
          serverVersion={serverVersion}
          open
          onOpenChange={(next) => {
            if (!next) setOpenHost(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Deep-link to the node on the Map, the same href the Servers table row uses. */
function nodeHref(nodeId: string): string {
  return `/assets/diagram?view=map&node=${nodeId}`;
}

/**
 * The bucket, and the version that produced it. `unknown` says so in words rather than rendering an
 * empty cell — an unstamped agent being indistinguishable from a current one is what made the
 * shipped #907 badge quietly useless (ADR-0094 §3).
 */
function VersionBadge({ node }: { node: AgentFleetNode }) {
  const t = useTranslations("infra.fleet");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={BUCKET_VARIANT[node.versionBucket]}>
        {t(`filter.${node.versionBucket}`)}
      </Badge>
      <span className="font-mono text-xs text-muted-foreground">
        {node.agentVersion ?? t("versionUnknownShort")}
      </span>
    </div>
  );
}

/** The reported OS family, or an explicit "unknown" — never a guess, and never a blank cell. */
function OsCell({ node }: { node: AgentFleetNode }) {
  const t = useTranslations("infra.fleet");
  if (!node.osFamily) {
    return <span className="text-xs text-muted-foreground">{t("osUnknown")}</span>;
  }
  return <span className="text-sm">{t(`os.${node.osFamily}`)}</span>;
}

/** Last check-in, relative — or the fact that there has never been one. */
function ReportedCell({ node }: { node: AgentFleetNode }) {
  const t = useTranslations("infra.fleet");
  const { relative, dateTime } = useFormatters();
  if (!node.lastReportedAt) {
    return <span className="text-xs text-muted-foreground">{t("neverReported")}</span>;
  }
  return (
    <span
      className="text-xs text-muted-foreground"
      title={dateTime(node.lastReportedAt)}
    >
      {node.status === "OFFLINE"
        ? t("reportedStale", { time: relative(node.lastReportedAt) })
        : t("reported", { time: relative(node.lastReportedAt) })}
    </span>
  );
}

/**
 * What is true about this row beyond its version: still awaiting review, gone quiet, or reporting
 * incompletely — item 1's own example, *"web-03: reporting unprivileged — no serial/model"*.
 */
function RowFlags({ node }: { node: AgentFleetNode }) {
  const t = useTranslations("infra.fleet");
  const warnings = node.diagnostics?.warnings ?? [];
  return (
    <span className="flex flex-wrap items-center gap-1">
      {node.pending ? <Badge variant="outline">{t("flags.pending")}</Badge> : null}
      {isNotReportingNode(node) ? (
        <StatusBadge tone="warning">{t("flags.notReporting")}</StatusBadge>
      ) : null}
      {node.degraded ? (
        <Badge
          variant="outline"
          title={
            warnings.length > 0
              ? t("flags.degradedWarnings", { warnings: warnings.join(", ") })
              : t("flags.degradedUnprivileged")
          }
        >
          {t("flags.degraded")}
        </Badge>
      ) : null}
    </span>
  );
}

/** The loading shape: the summary strip, then the table — so the layout does not jump on arrival. */
function FleetSkeleton() {
  const t = useTranslations("infra.fleet");
  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4">
        <Skeleton className="h-4 w-48" />
        <div className="mt-3 flex flex-wrap gap-2">
          {["a", "b", "c", "d"].map((key) => (
            <Skeleton key={key} className="h-8 w-28 rounded-md" />
          ))}
        </div>
      </div>
      <ResourceTable
        columns={[
          { key: "host", header: t("columns.host") },
          { key: "version", header: t("columns.version") },
          { key: "os", header: t("columns.os") },
          { key: "reported", header: t("columns.reported") },
        ]}
        isLoading
        mobileChildren={LOADING_MOBILE_CHILDREN}
      />
    </div>
  );
}
