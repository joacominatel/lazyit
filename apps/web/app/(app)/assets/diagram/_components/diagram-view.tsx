"use client";

import { PlusIcon, ShareIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
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
 */
export function DiagramView() {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
        <InfraCanvas onSelectNode={setSelectedId} />
      </div>

      <InfraNodePanel nodeId={selectedId} onClose={() => setSelectedId(null)} />
      {canManage ? (
        <CreateNodeDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </div>
  );
}
