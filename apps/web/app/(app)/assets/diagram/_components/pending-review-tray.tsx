"use client";

import {
  AdjustmentsHorizontalIcon,
  ArrowsPointingInIcon,
  CheckIcon,
  CubeIcon,
  InboxArrowDownIcon,
  ServerStackIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  hostExternalIdOfContainerChild,
  INFRA_BULK_REVIEW_MAX,
  InfraNodeKindSchema,
  ipInCidr,
  isContainerChildExternalId,
  matchesHostnamePattern,
  type InfraNodeKind,
  type InfraNodeListItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INFRA_LIVE_POLL_MS,
  useDeleteInfraNode,
  useInfraNodes,
} from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import { AgentBadge, AgentFreshness } from "./agent-provenance";
import { AutoConfirmRulesDialog } from "./auto-confirm-rules-dialog";
import { BulkConfirmDialog, BulkDiscardDialog } from "./bulk-review-dialogs";
import { ConfirmNodeDialog } from "./confirm-node-dialog";
import { DeleteNodeDialog } from "./delete-node-dialog";
import { MergeNodeDialog } from "./merge-node-dialog";
import { exceedsBulkReviewCap, visibleSelection } from "./tray-selection";

/** Sort orders the tray offers. Every one is a total order over the loaded rows (no server paging). */
type SortKey = "firstSeenDesc" | "firstSeenAsc" | "labelAsc" | "labelDesc";

/** One reporting host and the container children it enrolled — the unit the tray reviews. */
interface TrayGroup {
  /** `<reportingSource>::<host externalId>`, or the node id for a proposal with no reporting key. */
  key: string;
  /** The host's own PENDING proposal, when the host itself is still awaiting review. */
  host: InfraNodeListItem | null;
  /** The host's label, resolved from the loaded node list when the host itself is not pending. */
  hostLabel: string;
  children: InfraNodeListItem[];
  /** Oldest `createdAt` in the group — what "first seen" sorts on. */
  firstSeen: number;
}

/**
 * The PENDING review tray (ADR-0074 §3), rebuilt for a real rollout (§1 amendment, #1145).
 *
 * The gate is unchanged and deliberately so: the reporting agent still lands every new node as
 * `state=PENDING`, `source=AGENT`, and the official inventory is still never mutated by a machine
 * without human approval (§1/§8). What changed is the COST of exercising it. Since #1139 a single
 * Docker host enrols itself plus one CONTAINER child per running container, so one modest host
 * produces dozens of rows where it used to produce one — and the tray's only answer was a dialog per
 * row.
 *
 * Four things address that, none of them touching the gate:
 *
 *  - **Grouping by reporting host.** A host and the containers it reported are ONE unit, because that
 *    is how the operator thinks about them and how they arrived. The group header's checkbox takes
 *    the host and its children together — the "confirm a host with its containers" action, expressed
 *    as a selection rather than a second confirm endpoint with its own semantics.
 *  - **Checkboxes + bulk confirm / discard** ({@link BulkConfirmDialog}), which apply the SAME
 *    per-node overrides the single confirm takes. `trackAsAsset` defaults ON for hosts and OFF for
 *    container children (`defaultTrackAsAsset`) so a bulk confirm of one Docker host does not mint
 *    thirty Assets nobody will curate. What a bulk action touches is always the VISIBLE selection —
 *    a row a filter hides is out of the action and out of the count — and a selection over
 *    `INFRA_BULK_REVIEW_MAX` disables the two actions with the reason shown, rather than letting the
 *    contract reject the whole batch after the operator has done all of the selecting.
 *  - **Filter + sort**, entirely client-side over the already-loaded lean list (#1135 removed `specs`
 *    from it, and nothing here re-fattens it — a checkbox row reads `label`, `kind`, `ipAddress`,
 *    `createdAt` and `externalId`, all of which the list projection already carries).
 *  - **Saved auto-confirm rules** ({@link AutoConfirmRulesDialog}) — the judgement expressed once
 *    instead of per host. Never retroactive: rules apply only to reports that arrive afterwards, and
 *    the dialog says so.
 *
 * Per-row actions are unchanged: Confirm ({@link ConfirmNodeDialog}), Merge into
 * ({@link MergeNodeDialog}, #1141) and Discard (the existing soft delete — no reject endpoint).
 *
 * Gated on `infra:manage`: the tray is an ACTION surface. Renders nothing while loading or when
 * nothing is pending. Uses its own `state=PENDING` query, independent of the table's filters.
 */
export function PendingReviewTray() {
  const t = useTranslations("infra.pending");
  const tInfra = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const canRead = useCan("infra:read");
  // Poll so a freshly-discovered host appears in the tray without a manual reload (#1081).
  const { data, isLoading } = useInfraNodes(
    { state: "PENDING" },
    { refetchInterval: INFRA_LIVE_POLL_MS },
  );
  // The unfiltered list, ALREADY cached and shared on this screen (the Servers table reads it for its
  // onboarding hero, the canvas for the board). It is used for exactly one thing: naming the host of a
  // container child whose host is no longer pending — otherwise that group would be headed by a raw
  // machine-id. No extra round-trip, and nothing here reads `specs` (the list projection has none).
  const { data: allNodes } = useInfraNodes({}, { enabled: canRead });
  const deleteNode = useDeleteInfraNode();

  const [confirmTarget, setConfirmTarget] = useState<InfraNodeListItem | null>(null);
  const [discardTarget, setDiscardTarget] = useState<InfraNodeListItem | null>(null);
  const [mergeTarget, setMergeTarget] = useState<InfraNodeListItem | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkDiscardOpen, setBulkDiscardOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  // Filters + sort, local to the tray (NOT in the URL): the tray is a transient work surface that
  // disappears the moment it is empty, so a filter surviving a reload would outlive its own list.
  const [query, setQuery] = useState("");
  const [subnet, setSubnet] = useState("");
  const [kindFilter, setKindFilter] = useState<InfraNodeKind | "ALL">("ALL");
  const [scopeFilter, setScopeFilter] = useState<"ALL" | "HOST" | "CONTAINER">("ALL");
  const [sort, setSort] = useState<SortKey>("firstSeenDesc");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const pending = useMemo(() => data ?? [], [data]);

  /** Host labels by `<reportingSource>::<externalId>`, for a child whose host is already confirmed. */
  const hostLabels = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const node of allNodes ?? []) {
      if (!node.externalId || isContainerChildExternalId(node.externalId)) continue;
      byKey.set(`${node.reportingSource ?? ""}::${node.externalId}`, node.label);
    }
    return byKey;
  }, [allNodes]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cidr = subnet.trim();
    return pending.filter((node) => {
      const isChild = isContainerChildExternalId(node.externalId);
      if (scopeFilter === "HOST" && isChild) return false;
      if (scopeFilter === "CONTAINER" && !isChild) return false;
      if (kindFilter !== "ALL" && node.kind !== kindFilter) return false;
      // The subnet box takes a CIDR and matches it with the SAME helper the saved rules use, so
      // "which hosts would this rule have caught" and "which hosts does this filter show" can never
      // be answered by two different implementations. A half-typed CIDR simply matches nothing.
      if (cidr && !ipInCidr(node.ipAddress, cidr)) return false;
      if (!needle) return true;
      // A `*`/`?` in the box is read as a hostname glob — the same syntax a rule's pattern uses — so
      // an operator can try `srv-*` here before saving it as a rule. Plain text stays a substring
      // match, which is what a search box is expected to do.
      if (needle.includes("*") || needle.includes("?")) {
        return matchesHostnamePattern(needle, node.label);
      }
      return (
        node.label.toLowerCase().includes(needle) ||
        (node.ipAddress?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [pending, query, subnet, kindFilter, scopeFilter]);

  const groups = useMemo(() => {
    const byKey = new Map<string, TrayGroup>();
    const groupFor = (key: string, hostLabel: string, seen: number): TrayGroup => {
      const existing = byKey.get(key);
      if (existing) {
        existing.firstSeen = Math.min(existing.firstSeen, seen);
        return existing;
      }
      const group: TrayGroup = {
        key,
        host: null,
        hostLabel,
        children: [],
        firstSeen: seen,
      };
      byKey.set(key, group);
      return group;
    };

    for (const node of rows) {
      const seen = new Date(node.createdAt).getTime();
      const childHostKey = hostExternalIdOfContainerChild(node.externalId);
      if (childHostKey !== undefined) {
        const key = `${node.reportingSource ?? ""}::${childHostKey}`;
        // A child whose host is not pending is still grouped under that host, named from the loaded
        // node list. Falling back to the raw key is honest — it is the only name we have — and it is
        // better than scattering the children as unrelated rows.
        const group = groupFor(key, hostLabels.get(key) ?? childHostKey, seen);
        group.children.push(node);
        continue;
      }
      const key = node.externalId
        ? `${node.reportingSource ?? ""}::${node.externalId}`
        : node.id;
      const group = groupFor(key, node.label, seen);
      group.host = node;
      group.hostLabel = node.label;
    }

    const sorted = [...byKey.values()];
    sorted.sort((a, b) => {
      switch (sort) {
        case "firstSeenAsc":
          return a.firstSeen - b.firstSeen;
        case "labelAsc":
          return a.hostLabel.localeCompare(b.hostLabel);
        case "labelDesc":
          return b.hostLabel.localeCompare(a.hostLabel);
        default:
          return b.firstSeen - a.firstSeen;
      }
    });
    for (const group of sorted) {
      group.children.sort((a, b) => a.label.localeCompare(b.label));
    }
    return sorted;
  }, [rows, hostLabels, sort]);

  const visibleIds = useMemo(() => rows.map((node) => node.id), [rows]);
  // A bulk action reaches EXACTLY what the operator can see. `selected` is a raw set of ids that
  // outlives a filter change; every ACTION and every COUNT goes through `visibleSelection` instead —
  // the number beside the buttons, both dialogs and the ids in the request — so a row a filter hides
  // leaves the action and the count in the same instant it leaves the screen. (The checkboxes below do
  // read `selected` directly, but only ever for a row that is on screen, and `checkedState` is only
  // ever asked about `visibleIds` or a group's own members.) `visibleSelection` and the cap live in
  // `tray-selection.ts` and are asserted in `tray-selection.test.ts` — both were prose promises before,
  // here, in the select-all label and in the Manual, and prose cannot be held to account.
  const selectedNodes = useMemo(() => visibleSelection(rows, selected), [rows, selected]);

  /** A batch is bounded by the contract (`INFRA_BULK_REVIEW_MAX`); the tray refuses before the API does. */
  const overCap = exceedsBulkReviewCap(selectedNodes.length);

  function toggle(ids: string[], next: boolean): void {
    setSelected((prev) => {
      const draft = new Set(prev);
      for (const id of ids) {
        if (next) draft.add(id);
        else draft.delete(id);
      }
      return draft;
    });
  }

  /** `true` / `false` / `"indeterminate"` for a checkbox covering `ids` (Radix's tri-state contract). */
  function checkedState(ids: string[]): boolean | "indeterminate" {
    if (ids.length === 0) return false;
    const chosen = ids.filter((id) => selected.has(id)).length;
    if (chosen === 0) return false;
    return chosen === ids.length ? true : "indeterminate";
  }

  const filtersActive =
    query !== "" || subnet !== "" || kindFilter !== "ALL" || scopeFilter !== "ALL";

  if (!canManage || isLoading || pending.length === 0) return null;

  return (
    <section
      className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-4"
      aria-label={t("title")}
    >
      <div className="flex items-start gap-2">
        <InboxArrowDownIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <Badge variant="secondary">{pending.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setRulesOpen(true)}>
          <AdjustmentsHorizontalIcon />
          {t("rulesAction")}
        </Button>
      </div>

      {/* Filter + sort bar. Client-side over the loaded list — the tray is unpaged by design. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="h-8 w-full sm:w-56"
        />
        <Input
          value={subnet}
          onChange={(event) => setSubnet(event.target.value)}
          placeholder={t("subnetPlaceholder")}
          aria-label={t("subnetPlaceholder")}
          className="h-8 w-full sm:w-44"
        />
        <Select
          value={scopeFilter}
          onValueChange={(value) => setScopeFilter(value as typeof scopeFilter)}
        >
          <SelectTrigger className="h-8 w-full sm:w-40" aria-label={t("scopeLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("scope.ALL")}</SelectItem>
            <SelectItem value="HOST">{t("scope.HOST")}</SelectItem>
            <SelectItem value="CONTAINER">{t("scope.CONTAINER")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={kindFilter}
          onValueChange={(value) => setKindFilter(value as InfraNodeKind | "ALL")}
        >
          <SelectTrigger className="h-8 w-full sm:w-40" aria-label={t("kindFilterLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("kindFilterAll")}</SelectItem>
            {InfraNodeKindSchema.options.map((option) => (
              <SelectItem key={option} value={option}>
                {tInfra(`kind.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
          <SelectTrigger className="h-8 w-full sm:w-48" aria-label={t("sortLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="firstSeenDesc">{t("sort.firstSeenDesc")}</SelectItem>
            <SelectItem value="firstSeenAsc">{t("sort.firstSeenAsc")}</SelectItem>
            <SelectItem value="labelAsc">{t("sort.labelAsc")}</SelectItem>
            <SelectItem value="labelDesc">{t("sort.labelDesc")}</SelectItem>
          </SelectContent>
        </Select>
        {filtersActive ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setSubnet("");
              setKindFilter("ALL");
              setScopeFilter("ALL");
            }}
          >
            {t("clearFilters")}
          </Button>
        ) : null}
      </div>

      {/* Selection bar. The master checkbox, the count and the two buttons all describe the SAME set:
          the ticked rows that are currently visible (`selectedNodes`). A "select all" that silently
          reached filtered-out rows would be the worst kind of bulk action, so narrowing a filter takes
          those rows out of all three at once. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2">
        <label className="flex items-center gap-2 text-xs font-medium">
          <Checkbox
            checked={checkedState(visibleIds)}
            onCheckedChange={(next) => toggle(visibleIds, next === true)}
            aria-label={t("selectAll")}
          />
          {t("selectAll")}
        </label>
        <span className="text-xs text-muted-foreground">
          {t("selectedCount", { count: selectedNodes.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            disabled={selectedNodes.length === 0 || overCap}
            onClick={() => setBulkConfirmOpen(true)}
          >
            <CheckIcon />
            {t("bulkConfirmAction")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={selectedNodes.length === 0 || overCap}
            onClick={() => setBulkDiscardOpen(true)}
          >
            <TrashIcon />
            {t("bulkDiscardAction")}
          </Button>
        </div>
        {/* Said BEFORE the request, next to the disabled buttons, rather than as a toast after the
            operator has done the selecting: the cap is the contract's, and this is where it is met. */}
        {overCap ? (
          <p className="w-full text-xs text-destructive">
            {t("overCap", { max: INFRA_BULK_REVIEW_MAX, count: selectedNodes.length })}
          </p>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <p className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
          {t("noMatches")}
        </p>
      ) : null}

      <ul className="space-y-2">
        {groups.map((group) => {
          const memberIds = [
            ...(group.host ? [group.host.id] : []),
            ...group.children.map((child) => child.id),
          ];
          const grouped = group.children.length > 0;
          return (
            <li key={group.key} className="overflow-hidden rounded-md border bg-card">
              {grouped ? (
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
                  <Checkbox
                    checked={checkedState(memberIds)}
                    onCheckedChange={(next) => toggle(memberIds, next === true)}
                    aria-label={t("selectGroup", { host: group.hostLabel })}
                  />
                  <ServerStackIcon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="truncate text-sm font-medium">{group.hostLabel}</span>
                  <Badge variant="outline">
                    {t("containerCount", { count: group.children.length })}
                  </Badge>
                  {group.host ? null : (
                    <span className="text-xs text-muted-foreground">
                      {t("hostAlreadyReviewed")}
                    </span>
                  )}
                </div>
              ) : null}

              <ul className="divide-y">
                {(group.host ? [group.host] : []).concat(group.children).map((node) => {
                  const isChild = isContainerChildExternalId(node.externalId);
                  return (
                    <li
                      key={node.id}
                      className={`flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between ${
                        isChild ? "sm:pl-9" : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <Checkbox
                          className="mt-1"
                          checked={selected.has(node.id)}
                          onCheckedChange={(next) => toggle([node.id], next === true)}
                          aria-label={node.label}
                        />
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {isChild ? (
                              <CubeIcon
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden
                              />
                            ) : null}
                            <span className="truncate text-sm font-medium">{node.label}</span>
                            <Badge variant="outline">{tInfra(`kind.${node.kind}`)}</Badge>
                            <AgentBadge />
                            {node.ipAddress ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                {node.ipAddress}
                              </span>
                            ) : null}
                          </div>
                          <AgentFreshness
                            reportingSource={node.reportingSource}
                            lastReportedAt={node.lastReportedAt}
                            status={node.status}
                          />
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" onClick={() => setConfirmTarget(node)}>
                          <CheckIcon />
                          {t("confirmAction")}
                        </Button>
                        {isChild ? null : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setMergeTarget(node)}
                          >
                            <ArrowsPointingInIcon />
                            {t("mergeAction")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDiscardTarget(node)}
                        >
                          <TrashIcon />
                          {t("discardAction")}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      {confirmTarget ? (
        <ConfirmNodeDialog
          key={confirmTarget.id}
          open
          onOpenChange={(open) => !open && setConfirmTarget(null)}
          node={confirmTarget}
        />
      ) : null}

      {mergeTarget ? (
        <MergeNodeDialog
          key={mergeTarget.id}
          open
          onOpenChange={(open) => !open && setMergeTarget(null)}
          node={mergeTarget}
        />
      ) : null}

      {discardTarget ? (
        <DeleteNodeDialog
          open
          onOpenChange={(open) => !open && setDiscardTarget(null)}
          label={discardTarget.label}
          onConfirm={() => deleteNode.mutateAsync(discardTarget.id)}
        />
      ) : null}

      {bulkConfirmOpen ? (
        <BulkConfirmDialog
          open
          onOpenChange={setBulkConfirmOpen}
          nodes={selectedNodes}
          onDone={() => setSelected(new Set())}
        />
      ) : null}

      {bulkDiscardOpen ? (
        <BulkDiscardDialog
          open
          onOpenChange={setBulkDiscardOpen}
          nodes={selectedNodes}
          onDone={() => setSelected(new Set())}
        />
      ) : null}

      <AutoConfirmRulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />
    </section>
  );
}
