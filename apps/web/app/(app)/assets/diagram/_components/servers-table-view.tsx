"use client";

import { ServerStackIcon, ShareIcon } from "@heroicons/react/24/outline";
import {
  type InfraNodeKind,
  InfraNodeKindSchema,
  type InfraNodeListItem,
  type InfraNodeOwner,
  type InfraNodeState,
  InfraNodeStateSchema,
  type InfraNodeStatus,
  InfraNodeStatusSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { EmptyState } from "@/components/empty-state";
import {
  ErrorState,
  LinkableRow,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  SortableHeader,
} from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
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
import { INFRA_LIVE_POLL_MS, useInfraNodes } from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { statusTone } from "@/lib/infra/canvas";
import { AgentOnboarding } from "./agent-onboarding";
import {
  AgentBadge,
  AgentFreshness,
  AgentOutdatedBadge,
} from "./agent-provenance";
import { CreateAgentWizard } from "./create-agent-wizard";
import { PendingReviewTray } from "./pending-review-tray";

/**
 * Topology › Table (ADR-0070 §6, issues #743 + #760) — the filtered LIST view of infra topology
 * nodes, the scannable sibling of the Map (the React Flow canvas). It is one of the two views the
 * Topology screen toggles between (`?view=map|table`, see {@link DiagramView}); it used to be its own
 * `/assets/servers` route, now folded in. Built on the same shared list infrastructure every other
 * entity list uses (`ResourceTable` / `LinkableRow` / `useListParams` / `SearchInput`), so it reads
 * and behaves like Assets / Locations / Applications.
 *
 * It renders ONLY the body — the filter bar + table — with NO `PageHeader` of its own: the Topology
 * page owns the single shared header (title + the Map/Table toggle), so the table view slots straight
 * under it without a duplicate heading (#760). The `?view` toggle lives one level up; this view never
 * reads or writes it.
 *
 * Data: `useInfraNodes({ kind, status, state, q, sort, dir, limit, offset })` (#741, paged in #1152),
 * whose rows are the ENRICHED `InfraNodeListItem` — each carries the linked Asset's `assetName` +
 * active `owners` (joined server-side in one query, ADR-0070 §6 / #750). Every one of those params
 * lives in the URL via `useListParams`, so they SURVIVE a Map↔Table switch (the switch only flips
 * `?view`, leaving the rest untouched) — and a row click deep-links `?node=<id>` which the Map view
 * honours when you flip back (#760).
 *
 * ponytail — search, sort and paging are SERVER-side now (#1152):
 *  - `GET /infra/nodes` is the house `Page<T>` (ADR-0030): `{ items, total, limit, offset }`, a sort
 *    allowlist, and server-side `q` over label / ipAddress / linked asset name / active owner
 *    name+email. So this table gets the ordinary house treatment — `SortableHeader` on the allowlisted
 *    columns, a `Pagination` footer over `total` — exactly as Consumables and Assets do it.
 *  - The in-memory `q` filter this file used to run is GONE, and its removal is the point rather than
 *    a tidy-up. Filtering a page in the browser double-filters (the API already applied `q`) and, far
 *    worse, keeps implying the search covered the estate when it only ever covered one window. The
 *    old reasoning — "the list is unpaged by design, the estate is small (ADR-0070)" — stopped being
 *    true the day one hypervisor could enrol 500 guests (ADR-0095) and one Docker host one node per
 *    container (#1139).
 *  - `asset` and `owner` stay UNSORTABLE: they are joined relations the API does not allowlist, so a
 *    header that looked clickable would be a 400. Assets treats model/owners the same way.
 */
const FILTER_DEFAULTS = { kind: "ALL", status: "ALL", state: "ALL" } as const;

/**
 * The wire sort key behind each sortable column. `ip` is the column key the table has always used;
 * `ipAddress` is what the API's allowlist calls it, and mapping the two here keeps the column ids
 * stable while sending the server a key it accepts.
 */
const SORT_KEYS = {
  label: "label",
  kind: "kind",
  status: "status",
  ip: "ipAddress",
} as const;

/** Stable empty placeholder for the loading skeleton's mobile children slot. */
const LOADING_MOBILE_CHILDREN = <></>;


export function ServersTableView() {
  const t = useTranslations("infra");
  const tServers = useTranslations("infra.servers");
  // Minting the reporting-agent Service Account needs settings:manage — the gate on every
  // /service-accounts route (ADR-0048) — so the "Add a server" affordance is gated on it, separate
  // from the infra:read that gates the list itself.
  const canMintServer = useCan("settings:manage");
  const [wizardOpen, setWizardOpen] = useState(false);

  // Whether the estate already has ANY agent-sourced node (across every state) — drives the onboarding
  // hero vs. the compact "Add agent" affordance (ADR-0074 §6). A COUNT question, so it asks for a count
  // (#1152): a one-row `source=AGENT` page whose `total` answers it exactly. It used to scan the whole
  // node list with `.some(...)`, which on a paged endpoint would have inspected one window and shown a
  // "get started" hero to an estate whose only agents sat on page two. `undefined` while loading → the
  // hero stays hidden (no flash).
  const { data: agentProbe } = useInfraNodes({ source: "AGENT", limit: 1 });
  const hasAgents = agentProbe ? agentProbe.total > 0 : undefined;

  const {
    q,
    sort,
    dir,
    offset,
    limit,
    filters,
    setQ,
    toggleSort,
    setFilter,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({ filters: FILTER_DEFAULTS });

  const kindFilter = filters.kind as InfraNodeKind | "ALL";
  const statusFilter = filters.status as InfraNodeStatus | "ALL";
  const stateFilter = filters.state as InfraNodeState | "ALL";

  // Every param goes to the server, `q` included (#1152) — there is no in-memory pass after this.
  const {
    data: page,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useInfraNodes(
    {
      kind: kindFilter === "ALL" ? undefined : kindFilter,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      state: stateFilter === "ALL" ? undefined : stateFilter,
      q: q || undefined,
      sort,
      dir,
      limit,
      offset,
    },
    // Poll so live nodes show fresh lastReportedAt/status/IP without a manual reload (#1081).
    { refetchInterval: INFRA_LIVE_POLL_MS },
  );

  // The page is already scoped server-side, so rows are its items verbatim — no client-side re-filter.
  const rows = useMemo(() => page?.items ?? [], [page?.items]);

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "label",
        header: (
          <SortableHeader
            label={tServers("columns.label")}
            active={sort === SORT_KEYS.label}
            direction={dir}
            onToggle={() => toggleSort(SORT_KEYS.label)}
          />
        ),
        skeleton: <Skeleton className="h-4 w-40" />,
      },
      {
        key: "kind",
        header: (
          <SortableHeader
            label={tServers("columns.kind")}
            active={sort === SORT_KEYS.kind}
            direction={dir}
            onToggle={() => toggleSort(SORT_KEYS.kind)}
          />
        ),
        skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
      },
      {
        key: "status",
        header: (
          <SortableHeader
            label={tServers("columns.status")}
            active={sort === SORT_KEYS.status}
            direction={dir}
            onToggle={() => toggleSort(SORT_KEYS.status)}
          />
        ),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        // Not sortable: `assetName` is a joined relation, off the API's sort allowlist (an unknown
        // key 400s). Assets leaves its model column plain for the same reason.
        key: "asset",
        header: tServers("columns.asset"),
        skeleton: <Skeleton className="h-5 w-24 rounded-full" />,
      },
      {
        // Not sortable either — `owners` is a many-hop join (Asset → active AssetAssignment → User).
        key: "owner",
        header: tServers("columns.owner"),
        skeleton: <Skeleton className="h-4 w-28" />,
      },
      {
        key: "ip",
        header: (
          <SortableHeader
            label={tServers("columns.ip")}
            active={sort === SORT_KEYS.ip}
            direction={dir}
            onToggle={() => toggleSort(SORT_KEYS.ip)}
          />
        ),
        skeleton: <Skeleton className="h-4 w-28" />,
      },
    ],
    [tServers, sort, dir, toggleSort],
  );

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  const chips = [
    ...(q
      ? [
          {
            key: "q",
            label: tServers("chipSearch", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
    ...(kindFilter !== "ALL"
      ? [
          {
            key: "kind",
            label: tServers("chipKind", { kind: t(`kind.${kindFilter}`) }),
            onClear: () => setFilter("kind", FILTER_DEFAULTS.kind),
          },
        ]
      : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: tServers("chipStatus", { status: t(`status.${statusFilter}`) }),
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
    ...(stateFilter !== "ALL"
      ? [
          {
            key: "state",
            label: tServers("chipState", { state: t(`state.${stateFilter}`) }),
            onClear: () => setFilter("state", FILTER_DEFAULTS.state),
          },
        ]
      : []),
  ];

  // The PENDING review tray + the "Add a server" affordance wrap EVERY body state (loading / error /
  // empty / table), so they stay reachable — you can add the FIRST server while the table is still
  // empty, and confirm a discovered host even with the table filtered to nothing (ADR-0074 §3/§6).
  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <ResourceTable
        columns={columns}
        isLoading
        mobileChildren={LOADING_MOBILE_CHILDREN}
      />
    );
  } else if (isError) {
    body = (
      <ErrorState
        title={tServers("loadError")}
        onRetry={() => refetch()}
        error={error}
      />
    );
  } else if (isEmpty && !filtersActive) {
    body = (
      <EmptyState
        icon={ServerStackIcon}
        pillar="inventory"
        title={t("empty.title")}
        description={t("empty.description")}
      />
    );
  } else {
    body = (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput
          value={q}
          debounceMs={300}
          onDebouncedChange={setQ}
          label={tServers("searchLabel")}
          placeholder={tServers("searchPlaceholder")}
          className="sm:max-w-xs sm:flex-1"
        />
        <Select
          value={kindFilter}
          onValueChange={(value) => setFilter("kind", value)}
        >
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{tServers("allKinds")}</SelectItem>
            {InfraNodeKindSchema.options.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(value) => setFilter("status", value)}
        >
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{tServers("allStatuses")}</SelectItem>
            {InfraNodeStatusSchema.options.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={stateFilter}
          onValueChange={(value) => setFilter("state", value)}
        >
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{tServers("allStates")}</SelectItem>
            {InfraNodeStateSchema.options.map((state) => (
              <SelectItem key={state} value={state}>
                {t(`state.${state}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ActiveFilters chips={chips} onClearAll={clearFilters} />

      <ResourceTable
        columns={columns}
        isFilteredEmpty={rows.length === 0}
        filteredEmptyMessage={tServers("filteredEmpty")}
        filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
        mobileChildren={rows.map((node) => (
          <ResourceCard
            key={node.id}
            href={diagramHref(node.id)}
            title={node.label}
            badge={
              <StatusBadge tone={statusTone(node.status)}>
                {t(`status.${node.status}`)}
              </StatusBadge>
            }
            meta={
              <>
                <ResourceCardMeta label={t("facts.kind")}>
                  <Badge variant="outline">{t(`kind.${node.kind}`)}</Badge>
                </ResourceCardMeta>
                <ResourceCardMeta label={tServers("meta.asset")}>
                  <AssetCell assetId={node.assetId} assetName={node.assetName} />
                </ResourceCardMeta>
                <ResourceCardMeta
                  label={tServers("meta.owner")}
                  className="col-span-2"
                >
                  <OwnersCell owners={node.owners} />
                </ResourceCardMeta>
                <ResourceCardMeta
                  label={tServers("meta.ip")}
                  className="col-span-2"
                >
                  {node.ipAddress ?? "—"}
                </ResourceCardMeta>
                {node.source === "AGENT" ? (
                  <ResourceCardMeta
                    label={tServers("meta.source")}
                    className="col-span-2"
                  >
                    <div className="flex flex-col items-start gap-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <AgentBadge />
                        <AgentOutdatedBadge agentVersion={node.agentVersion} />
                      </div>
                      <AgentFreshness
                        reportingSource={node.reportingSource}
                        lastReportedAt={node.lastReportedAt}
                        status={node.status}
                      />
                    </div>
                  </ResourceCardMeta>
                ) : null}
              </>
            }
          />
        ))}
      >
        {rows.map((node) => (
          <LinkableRow key={node.id} href={diagramHref(node.id)}>
            <TableCell className="font-medium">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={diagramHref(node.id)}
                    className="hover:underline"
                  >
                    {node.label}
                  </Link>
                  {node.source === "AGENT" ? <AgentBadge /> : null}
                  {node.source === "AGENT" ? (
                    <AgentOutdatedBadge agentVersion={node.agentVersion} />
                  ) : null}
                </div>
                {node.source === "AGENT" ? (
                  <AgentFreshness
                    reportingSource={node.reportingSource}
                    lastReportedAt={node.lastReportedAt}
                    status={node.status}
                  />
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{t(`kind.${node.kind}`)}</Badge>
            </TableCell>
            <TableCell>
              <StatusBadge tone={statusTone(node.status)}>
                {t(`status.${node.status}`)}
              </StatusBadge>
            </TableCell>
            <TableCell>
              <AssetCell assetId={node.assetId} assetName={node.assetName} />
            </TableCell>
            <TableCell>
              <OwnersCell owners={node.owners} />
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {node.ipAddress ?? "—"}
            </TableCell>
          </LinkableRow>
        ))}
      </ResourceTable>

      {/* The window is over `total` — the count of what the FILTERS asked for, not of the table — so
          "1–50 of 431" is a true statement about this query. Without it a server-paged list is the
          exact failure #1152 exists to stop: fifty rows that look like all of them. */}
      <Pagination
        total={total}
        limit={page?.limit ?? limit}
        offset={page?.offset ?? offset}
        itemCount={page?.items.length ?? 0}
        onOffsetChange={setOffset}
        isFetching={isFetching}
      />
    </div>
    );
  }

  return (
    <div className="space-y-6">
      <AgentOnboarding
        canMint={canMintServer}
        hasAgents={hasAgents}
        onCreate={() => setWizardOpen(true)}
      />

      <PendingReviewTray />

      {body}

      {canMintServer ? (
        <CreateAgentWizard open={wizardOpen} onOpenChange={setWizardOpen} />
      ) : null}
    </div>
  );
}

/**
 * Row-open (ADR-0070 §6): deep-link into the Map view, seeding its drill-in with this node via
 * `?node=<id>` (honoured by `DiagramView`) while flipping `?view` to `map`. ponytail: reuses the
 * existing detail modal — the whole asset-backed payoff (owner, KB, secrets, connections, reported
 * facts) — instead of building a parallel detail route. Carrying `view=map` makes a Table row click
 * land on the canvas with that node selected AND its detail open, so the click-only-selects rule of
 * #1182 does not reach a row (the state-preserving deep-link, #760).
 *
 * That last sentence is only true because `DiagramView` applies `?node=` whenever the param CHANGES.
 * A row click is a client-side navigation to the SAME route, so the view never remounts: while the
 * id was read once in a `useState` initializer, this link flipped to the Map and selected nothing —
 * the promise was kept only for a pasted URL or a hard reload. See `node-deep-link.ts`.
 */
function diagramHref(nodeId: string): string {
  return `/assets/diagram?view=map&node=${nodeId}`;
}

/**
 * The Asset column: a node is either Asset-backed (`assetId` set) or graph-only. Now that the list
 * payload carries the linked Asset's inventory NAME (#750), an asset-backed row shows that name; a
 * graph-only row keeps the LINKAGE affordance (the Share glyph + "Graph-only" label). `assetName` can
 * be null even with an `assetId` — a soft-deleted/detached asset's name is deliberately withheld by
 * the API — so that case falls back to the "tracked" label (linkage known, name not surfaced).
 */
function AssetCell({
  assetId,
  assetName,
}: {
  assetId: InfraNodeListItem["assetId"];
  assetName: InfraNodeListItem["assetName"];
}) {
  const tServers = useTranslations("infra.servers");
  if (!assetId) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <ShareIcon className="size-3.5" />
        {tServers("asset.graphOnly")}
      </span>
    );
  }
  return assetName ? (
    <span className="truncate">{assetName}</span>
  ) : (
    <Badge variant="secondary">{tServers("asset.tracked")}</Badge>
  );
}

/**
 * The Owner column: the active owners of the node's linked Asset (asset-centric — ADR-0004/0019).
 * ponytail: render the FIRST owner's name + a "+N more" hint for multi-owner so the row never bloats;
 * the full list lives in the detail modal's General tab one click away. A departed owner (their User
 * soft-deleted but the assignment never released) renders muted with line-through — the same
 * affordance that tab uses (`OwnersSection`), so the two surfaces read consistently. Em-dash when
 * unowned / graph-only.
 */
function OwnersCell({ owners }: { owners: InfraNodeOwner[] }) {
  const tServers = useTranslations("infra.servers");
  if (owners.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const [first, ...rest] = owners;
  const gone = first.deletedAt !== null;
  const name = `${first.firstName} ${first.lastName}`.trim() || first.email;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={gone ? "text-muted-foreground line-through" : undefined}
        title={gone ? tServers("owner.departed", { name }) : name}
      >
        {name}
      </span>
      {rest.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          {tServers("owner.more", { count: rest.length })}
        </span>
      ) : null}
    </span>
  );
}
