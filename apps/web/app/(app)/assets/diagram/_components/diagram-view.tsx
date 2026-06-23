"use client";

import { ShareIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { InfraCanvas } from "./infra-canvas";

/**
 * The Assets › Diagram screen (ADR-0070 §6, issue #741): the page header + the React Flow board.
 *
 * Client-only on purpose — React Flow renders in the browser, so there is NO SSR prefetch (the
 * canvas's data is fetched client-side via TanStack Query, per #741). The board fills a fixed
 * viewport-relative height so pan/zoom has room without the page itself scrolling.
 *
 * `selectedId` is held here as the SEAM for #742's rich drill-in panel: the canvas already reports
 * the clicked node via `onSelectNode`; #742 will read this id and render the owner/KB/secret panel
 * beside the board. Nothing is built on it here beyond the wiring.
 */
export function DiagramView() {
  const t = useTranslations("infra");
  // ponytail: the selection seam for #742 — wired now, consumed later. The setter is the live use;
  // the value is read by the panel #742 adds.
  const [, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex h-[calc(100svh-8rem)] min-h-[28rem] flex-col gap-4">
      <PageHeader
        title={t("title")}
        pillar="inventory"
        icon={ShareIcon}
        subtitle={t("subtitle")}
      />
      <div className="min-h-0 flex-1">
        <InfraCanvas onSelectNode={setSelectedId} />
      </div>
    </div>
  );
}
