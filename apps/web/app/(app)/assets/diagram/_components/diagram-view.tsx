"use client";

import { PlusIcon, ShareIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useInfraImpact } from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import { CreateNodeDialog } from "./create-node-dialog";
import { InfraCanvas } from "./infra-canvas";
import { InfraNodePanel } from "./infra-node-panel";

/**
 * The Assets › Diagram screen (ADR-0070 §6): the page header + the React Flow board + the drill-in
 * payoff (issue #742).
 *
 * Client-only on purpose — React Flow renders in the browser, so there is NO SSR prefetch (the
 * canvas's data is fetched client-side via TanStack Query, per #741). The board fills a fixed
 * viewport-relative height so pan/zoom has room without the page itself scrolling.
 *
 * `selectedId` is the selection seam the canvas (#741) exposes via `onSelectNode`: clicking a node
 * sets it and opens the {@link InfraNodePanel} (owner/KB/secret-handles/shortcuts/children + the
 * write controls). The header's "Add node" action is gated on `infra:manage` (read-only viewers
 * still get the board + the read-only panel; the API is the real gate).
 *
 * A `?node=<id>` query param seeds the initial selection so the Servers list (#743) can deep-link a
 * row straight into the drill-in panel. ponytail: a one-shot seed via `useState`'s initializer (read
 * once on mount), not a synced effect — the URL drives the FIRST open, then the user owns the
 * selection. The panel works from a bare nodeId alone (it fetches its own detail), so no canvas pan
 * is needed for the payoff to show.
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
  const initialNodeId = useSearchParams().get("node");
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
    <div className="flex h-[calc(100svh-8rem)] min-h-[28rem] flex-col gap-4">
      <PageHeader
        title={t("title")}
        pillar="inventory"
        icon={ShareIcon}
        subtitle={t("subtitle")}
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              {t("create.action")}
            </Button>
          ) : undefined
        }
      />
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
      {canManage ? (
        <CreateNodeDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </div>
  );
}
