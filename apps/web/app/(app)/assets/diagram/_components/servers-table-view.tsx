"use client";

import { ServerStackIcon, ShareIcon } from "@heroicons/react/24/outline";
import {
  type InfraNode,
  type InfraNodeKind,
  InfraNodeKindSchema,
  type InfraNodeState,
  InfraNodeStateSchema,
  type InfraNodeStatus,
  InfraNodeStatusSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
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
import { useInfraNodes } from "@/lib/api/hooks/use-infra-nodes";
import { useListParams } from "@/lib/hooks/use-list-params";
import { statusTone } from "@/lib/infra/canvas";

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
 * Data: reuses `useInfraNodes({ kind, status, state })` (#741). kind/status/state are SERVER-side
 * filters (the API supports them); `q` is a CLIENT-side text filter over label + IP. All of these
 * live in the URL via `useListParams`, so they SURVIVE a Map↔Table switch (the switch only flips
 * `?view`, leaving the filter params untouched) — and a row click deep-links `?node=<id>` which the
 * Map view honours when you flip back (#760).
 *
 * ponytail — search & paging are client-side, not server-driven:
 *  - The infra node list is UNPAGED by design (ADR-0070: the estate is small) — `getInfraNodes`
 *    returns a plain `InfraNode[]`, no `{ items, total }` envelope, no sort allowlist. So this list
 *    has no Pagination / SortableHeader and filters the loaded array in memory (the Locations
 *    precedent: "type is filtered client-side over the page"). No new endpoint, no Meili coupling.
 *  - Search matches label + ipAddress. The Meili-backed `/search` hit also carries `assetName`, but
 *    the `/infra/nodes` list payload does NOT (it has only `assetId`), and the `/search` endpoint
 *    takes no kind/status/state filter param — so a search-by-asset-name surface needs an API/contract
 *    change out of this web-only PR's lane. Tracked as a follow-up; the row's drill-in panel already
 *    shows the asset name + owners.
 */
const FILTER_DEFAULTS = { kind: "ALL", status: "ALL", state: "ALL" } as const;

export function ServersTableView() {
  const t = useTranslations("infra");
  const tServers = useTranslations("infra.servers");

  const {
    q,
    filters,
    setQ,
    setFilter,
    clearFilters,
    filtersActive,
  } = useListParams({ filters: FILTER_DEFAULTS });

  const kindFilter = filters.kind as InfraNodeKind | "ALL";
  const statusFilter = filters.status as InfraNodeStatus | "ALL";
  const stateFilter = filters.state as InfraNodeState | "ALL";

  // Forward only the server-supported filters; `q` filters client-side over the result below.
  const {
    data: nodes,
    isLoading,
    isError,
    error,
    refetch,
  } = useInfraNodes({
    kind: kindFilter === "ALL" ? undefined : kindFilter,
    status: statusFilter === "ALL" ? undefined : statusFilter,
    state: stateFilter === "ALL" ? undefined : stateFilter,
  });

  // Client-side text search over label + IP (the list is unpaged — see the file header).
  const rows = useMemo(() => {
    const items = nodes ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (node) =>
        node.label.toLowerCase().includes(needle) ||
        (node.ipAddress?.toLowerCase().includes(needle) ?? false),
    );
  }, [nodes, q]);

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "label",
        header: tServers("columns.label"),
        skeleton: <Skeleton className="h-4 w-40" />,
      },
      {
        key: "kind",
        header: tServers("columns.kind"),
        skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
      },
      {
        key: "status",
        header: tServers("columns.status"),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "asset",
        header: tServers("columns.asset"),
        skeleton: <Skeleton className="h-5 w-24 rounded-full" />,
      },
      {
        key: "ip",
        header: tServers("columns.ip"),
        skeleton: <Skeleton className="h-4 w-28" />,
      },
    ],
    [tServers],
  );

  const isEmpty = (nodes?.length ?? 0) === 0;

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

  if (isLoading) {
    return <ResourceTable columns={columns} isLoading mobileChildren={<></>} />;
  }
  if (isError) {
    return (
      <ErrorState
        title={tServers("loadError")}
        onRetry={() => refetch()}
        error={error}
      />
    );
  }
  if (isEmpty && !filtersActive) {
    return (
      <EmptyState
        icon={ServerStackIcon}
        pillar="inventory"
        title={t("empty.title")}
        description={t("empty.description")}
      />
    );
  }

  return (
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
                  <AssetCell assetId={node.assetId} />
                </ResourceCardMeta>
                <ResourceCardMeta
                  label={tServers("meta.ip")}
                  className="col-span-2"
                >
                  {node.ipAddress ?? "—"}
                </ResourceCardMeta>
              </>
            }
          />
        ))}
      >
        {rows.map((node) => (
          <LinkableRow key={node.id} href={diagramHref(node.id)}>
            <TableCell className="font-medium">
              <Link href={diagramHref(node.id)} className="hover:underline">
                {node.label}
              </Link>
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
              <AssetCell assetId={node.assetId} />
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {node.ipAddress ?? "—"}
            </TableCell>
          </LinkableRow>
        ))}
      </ResourceTable>
    </div>
  );
}

/**
 * Row-open (ADR-0070 §6): deep-link into the Map view, seeding its drill-in panel with this node via
 * `?node=<id>` (honoured by `DiagramView`) while flipping `?view` to `map`. ponytail: reuses the
 * existing panel — the whole asset-backed payoff (owner, KB, secrets, connections) — instead of
 * building a parallel detail route. Carrying `view=map` makes a Table row click land on the canvas
 * with that node selected (the state-preserving deep-link, #760).
 */
function diagramHref(nodeId: string): string {
  return `/assets/diagram?view=map&node=${nodeId}`;
}

/**
 * The Asset column: a node is either Asset-backed (`assetId` set) or graph-only. ponytail: the list
 * payload carries only `assetId`, not the inventory NAME or owners (those are detail-only) — so this
 * shows the LINKAGE, and the full asset name + owners live one click away in the drill-in panel. A
 * list-payload enrichment to show the name/owner inline (without an N+1 detail fetch per row) is a
 * follow-up API change.
 */
function AssetCell({ assetId }: { assetId: InfraNode["assetId"] }) {
  const tServers = useTranslations("infra.servers");
  return assetId ? (
    <Badge variant="secondary">{tServers("asset.tracked")}</Badge>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <ShareIcon className="size-3.5" />
      {tServers("asset.graphOnly")}
    </span>
  );
}
