"use client";

import {
  PlusIcon,
  ShareIcon,
  TableCellsIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInfraImpact } from "@/lib/api/hooks/use-infra-nodes";
import { buildNextUrl } from "@/lib/hooks/list-params-url";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { CreateNodeDialog } from "./create-node-dialog";
import { InfraCanvas } from "./infra-canvas";
import { InfraNodePanel } from "./infra-node-panel";
import { ServersTableView } from "./servers-table-view";

/**
 * The Assets › Topology screen (ADR-0070 §6): the page header + a Map/Table view toggle, then either
 * the React Flow board + drill-in payoff (the Map, issue #742) or the filterable node list (the
 * Table, issue #743 — formerly the standalone `/assets/servers` route).
 *
 * One destination, two views (#760). A `?view=map|table` search param picks the view; the segmented
 * control in the header's actions slot flips it. ponytail: `view` is read from the URL (no local
 * mirror) and written with the shared `buildNextUrl` patch helper, so a Map↔Table switch PRESERVES
 * every other param — the Table's filters (`kind`/`status`/`state`/`q`, all URL-backed via
 * `useListParams`) and a `?node=` selection survive the switch untouched. Any value other than
 * `table` degrades to the Map (a tampered `?view` never errors).
 *
 * Client-only on purpose — React Flow renders in the browser, so there is NO SSR prefetch (the
 * canvas's data is fetched client-side via TanStack Query, per #741). In the Map view the board fills
 * a fixed viewport-relative height so pan/zoom has room without the page itself scrolling; the Table
 * view is a normal scrolling page, so the height clamp applies only to the Map.
 *
 * `selectedId` is the selection seam the canvas (#741) exposes via `onSelectNode`: clicking a node
 * sets it and opens the {@link InfraNodePanel} (owner/KB/secret-handles/shortcuts/children + the
 * write controls). The header's "Add node" action is gated on `infra:manage` (read-only viewers
 * still get the board + the read-only panel; the API is the real gate).
 *
 * A `?node=<id>` query param seeds the initial selection so a Table row (or any deep-link) can land
 * on the Map with that node's drill-in panel open. ponytail: a one-shot seed via `useState`'s
 * initializer (read once on mount), not a synced effect — the URL drives the FIRST open, then the
 * user owns the selection. The panel works from a bare nodeId alone (it fetches its own detail), so
 * no canvas pan is needed for the payoff to show.
 *
 * Impact / blast-radius (ADR-0070 §7, issue #755) lives HERE because the canvas and the panel both
 * read it: `impactOn` is the toggle the panel flips; the impact query runs once for the selected
 * node and feeds the panel its count/list AND the canvas its highlight set. Selecting another node
 * (or closing the panel) turns impact mode off so a stale radius never lingers — minimal lifted
 * state, no global store (the seam #741 already exposes for selection).
 */
export function DiagramView() {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "table" ? "table" : "map";
  const initialNodeId = searchParams.get("node");
  const [selectedId, setSelectedId] = useState<string | null>(initialNodeId);
  const [impactOn, setImpactOn] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Selecting (or clearing) a node always exits impact mode — the radius is per-node, so it would be
  // wrong to carry the previous node's highlight onto a new selection.
  function selectNode(nodeId: string | null) {
    setSelectedId(nodeId);
    setImpactOn(false);
  }

  const { data: impact, isLoading: impactLoading } = useInfraImpact(
    selectedId,
    impactOn,
  );
  // The id set the canvas highlights — only meaningful while impact mode is on for THIS node.
  const affectedIds = useMemo(
    () =>
      impactOn && impact ? new Set(impact.affected.map((n) => n.id)) : undefined,
    [impactOn, impact],
  );
  const impactRootId = impactOn ? selectedId : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        // The Map needs a fixed viewport-relative height so pan/zoom has room; the Table scrolls
        // with the page, so the clamp applies only in Map view.
        view === "map" && "h-[calc(100svh-8rem)] min-h-[28rem]",
      )}
    >
      <PageHeader
        title={t("title")}
        pillar="inventory"
        icon={ShareIcon}
        subtitle={t("subtitle")}
        actions={
          <div className="flex shrink-0 items-center gap-2">
            <ViewToggle view={view} />
            {canManage ? (
              <Button onClick={() => setCreateOpen(true)}>
                <PlusIcon />
                {t("create.action")}
              </Button>
            ) : null}
          </div>
        }
      />

      {view === "table" ? (
        <ServersTableView />
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <InfraCanvas
              onSelectNode={selectNode}
              impactRootId={impactRootId}
              affectedIds={affectedIds}
            />
          </div>

          <InfraNodePanel
            nodeId={selectedId}
            onClose={() => selectNode(null)}
            impactOn={impactOn}
            onToggleImpact={() => setImpactOn((on) => !on)}
            impact={impactOn ? impact : undefined}
            impactLoading={impactOn && impactLoading}
          />
        </>
      )}

      {canManage ? (
        <CreateNodeDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </div>
  );
}

/**
 * The Map ⇄ Table segmented control (#760). A compact two-tab `Tabs` (the shadcn primitive the
 * Reports screen already uses — NO new dependency) sitting in the header actions slot, left of "Add
 * node". It drives `?view` directly: switching writes the param with `buildNextUrl` so every OTHER
 * param (the Table filters + a `?node=` selection) is preserved across the switch, then `router
 * .replace(..., { scroll: false })` keeps the URL shareable/Back-navigable without a scroll jump.
 * `inventory` pillar tint on the active underline so the toggle wears the Topology hue (ADR-0049).
 */
function ViewToggle({ view }: { view: "map" | "table" }) {
  const t = useTranslations("infra.view");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <Tabs
      value={view}
      onValueChange={(next) =>
        router.replace(
          buildNextUrl(searchParams.toString(), pathname, {
            // Drop the param on the default view to keep URLs clean (mirrors useListParams).
            view: next === "map" ? undefined : next,
          }),
          { scroll: false },
        )
      }
    >
      <TabsList className="w-auto">
        <TabsTrigger
          value="map"
          indicatorClassName="data-[state=active]:border-pillar-inventory"
        >
          <ShareIcon aria-hidden />
          {t("map")}
        </TabsTrigger>
        <TabsTrigger
          value="table"
          indicatorClassName="data-[state=active]:border-pillar-inventory"
        >
          <TableCellsIcon aria-hidden />
          {t("table")}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
