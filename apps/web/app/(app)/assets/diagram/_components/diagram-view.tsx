"use client";

import { ShareIcon, TableCellsIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInfraImpact } from "@/lib/api/hooks/use-infra-nodes";
import { buildNextUrl } from "@/lib/hooks/list-params-url";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { AddNodeMenu } from "./add-node-menu";
import { CreateAgentWizard } from "./create-agent-wizard";
import { CreateNodeDialog } from "./create-node-dialog";
import { InfraCanvas, type InfraCanvasApi } from "./infra-canvas";
import { NodeDetailModal } from "./node-detail-modal";
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
 * **Selection and detail are two different things** since #1182. `selectedId` is what the canvas
 * highlights and what the on-canvas action bar acts on; `detailId` is what the {@link NodeDetailModal}
 * shows. Clicking a node only selects it, because the detail is now a large modal and opening one
 * over the board on every click would bury the map the operator came to read — and would make the
 * blast-radius control, whose entire output is drawn on that map, unusable. Detail opens from the
 * action bar's **Details** button, a double-click, or a deep link.
 *
 * A `?node=<id>` query param seeds BOTH, so a Table row (or any deep-link) still lands on the Map
 * with that node's detail open, exactly as before. ponytail: a one-shot seed via `useState`'s
 * initializer (read once on mount), not a synced effect — the URL drives the FIRST open, then the
 * user owns the selection.
 *
 * `?focus=1` (issue #765) additionally asks the canvas to *fly to* the seeded node — used by the
 * Assets "View in topology" button. The canvas exposes a `focusNode(id)` primitive via `onApiReady`;
 * we call it once, the first time the API is ready, if the deep-link asked for it (`?node=&focus=1`).
 * A bare `?node=` (no focus) just opens the detail, no camera move.
 *
 * Impact / blast-radius (ADR-0070 §7, issue #755) lives HERE because the query is per-selected-node:
 * `impactOn` is the toggle the canvas's action bar flips, and the one response feeds the canvas both
 * its highlight set and its summary. Selecting another node (or clearing the selection) turns impact
 * mode off so a stale radius never lingers — minimal lifted state, no global store.
 *
 * The header's add affordance (#1181) leads with the reporting agent and keeps the hand-drawn node
 * one click behind it; see {@link AddNodeMenu}. The two paths carry different permissions, so each is
 * gated on its own and the control renders only what this operator can actually do.
 */
export function DiagramView() {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  // Minting the reporting agent's Service Account needs settings:manage — the gate on every
  // /service-accounts route (ADR-0048) — a different permission from the infra:manage that gates
  // putting a node on the map by hand.
  const canMintAgent = useCan("settings:manage");
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "table" ? "table" : "map";
  const initialNodeId = searchParams.get("node");
  const [selectedId, setSelectedId] = useState<string | null>(initialNodeId);
  const [detailId, setDetailId] = useState<string | null>(initialNodeId);
  const [impactOn, setImpactOn] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  // One-shot deep-link focus (issue #765): if the URL is `?node=&focus=1`, fly to that node the
  // first time the canvas API is ready. Read once on mount (the URL drives the FIRST landing, then
  // the user owns the camera); the ref is nulled after firing so a later API re-ready never re-fires.
  const pendingFocusRef = useRef<string | null>(
    initialNodeId && searchParams.get("focus") === "1" ? initialNodeId : null,
  );
  const onCanvasReady = useCallback((api: InfraCanvasApi) => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    api.focusNode(target);
  }, []);

  // Selecting (or clearing) a node always exits impact mode — the radius is per-node, so it would be
  // wrong to carry the previous node's highlight onto a new selection.
  function selectNode(nodeId: string | null) {
    setSelectedId(nodeId);
    setImpactOn(false);
  }

  // Opening a node's detail also selects it, so closing the modal leaves the operator looking at the
  // node they were just reading about, with its action bar in place.
  function openDetail(nodeId: string) {
    if (nodeId !== selectedId) selectNode(nodeId);
    setDetailId(nodeId);
  }

  const { data: impact } = useInfraImpact(selectedId, impactOn);
  const impactRootId = impactOn ? selectedId : null;

  const addAffordance = (
    <AddNodeMenu
      canCreateAgent={canMintAgent}
      canCreateManual={canManage}
      onCreateAgent={() => setWizardOpen(true)}
      onCreateManual={() => setCreateOpen(true)}
    />
  );

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
            {addAffordance}
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
              selectedId={selectedId}
              onOpenDetail={openDetail}
              impactRootId={impactRootId}
              // Gated on the toggle, not just on the data: the query keeps its last answer cached,
              // and the canvas reads "resolved" as "not undefined". Until the radius for THIS node
              // has actually come back, the board must not dim to the reassuring
              // nothing-depends-on-this state and then re-light (#775).
              impact={impactOn ? impact : undefined}
              impactOn={impactOn}
              onToggleImpact={() => setImpactOn((on) => !on)}
              onApiReady={onCanvasReady}
              emptyAction={addAffordance}
            />
          </div>

          <NodeDetailModal
            nodeId={detailId}
            onClose={() => setDetailId(null)}
            onSelectNode={openDetail}
          />
        </>
      )}

      {canManage ? (
        <CreateNodeDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
      {canMintAgent ? (
        <CreateAgentWizard open={wizardOpen} onOpenChange={setWizardOpen} />
      ) : null}
    </div>
  );
}

/**
 * The Map ⇄ Table segmented control (#760). A compact two-tab `Tabs` (the shadcn primitive the
 * Reports screen already uses — NO new dependency) sitting in the header actions slot, left of the
 * add affordance. It drives `?view` directly: switching writes the param with `buildNextUrl` so every
 * OTHER param (the Table filters + a `?node=` selection) is preserved across the switch, then `router
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
