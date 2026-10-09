"use client";

import { ArrowTopRightOnSquareIcon, FolderIcon, TagIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { HelpTip } from "@/components/help-tip";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import { useAssetModelTotal } from "@/lib/api/hooks/use-asset-models";
import { useAssetStatusLabels } from "@/lib/api/hooks/use-asset-status-labels";
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { cn } from "@/lib/utils";
import { AdminGate } from "../_components/admin-gate";
import { AssetModelManager } from "../_components/asset-model-manager";
import { AssetStatusLabelManager } from "../_components/asset-status-label-manager";
import { CategoryManager } from "../_components/category-manager";
import {
  parseTaxonomyTab,
  TAXONOMY_GROUPS,
  type TaxonomyPane,
  type TaxonomySelection,
} from "../_components/taxonomy-tabs";

const KB_HREF = "/kb";

/**
 * Settings → Taxonomies (#1540). Two panes: on the left, every taxonomy grouped by module with its
 * count (Assets: categories, models, custom statuses · Applications · Consumables · Knowledge, which is
 * a link — KB folders are managed in the Knowledge Base); on the right, the selected taxonomy as a
 * compact list. Below `md` the left list becomes a picker so the page never scrolls sideways.
 *
 * The selection lives in `?tab=` (the old tab values, so existing links keep working; the old
 * `article` value shows the pointer to the KB), written with `history.replaceState` like the record
 * pages' tabs — switching never refetches the page.
 */
// ponytail: skipped from the ADR-0067 server-prefetch rollout — a selection shell whose primary read
// depends on the selected pane; no single stable first-paint query to prefetch.
export default function TaxonomiesPage() {
  const t = useTranslations("settings");
  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("taxonomies.title")}
          badge={
            <HelpTip topic={t("taxonomies.title")} href="/help/configuration-taxonomies">
              <p>{t("taxonomies.help")}</p>
            </HelpTip>
          }
        />
        {/* `useSearchParams` needs a Suspense boundary on a client page (the ?tab= deep link). */}
        <Suspense fallback={null}>
          <TaxonomyPanes />
        </Suspense>
      </div>
    </AdminGate>
  );
}

function useTaxonomySelection(): [TaxonomySelection, (next: TaxonomySelection) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const selection = parseTaxonomyTab(searchParams.get("tab"));
  const select = useCallback(
    (next: TaxonomySelection) => {
      const params = new URLSearchParams(window.location.search);
      params.set("tab", next);
      window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
    },
    [pathname],
  );
  return [selection, select];
}

/** Live counts per pane, from the same list reads the panes use (cached, so no extra request). */
function usePaneCounts(): Record<TaxonomyPane, number | undefined> {
  return {
    asset: useAssetCategories().data?.length,
    // The envelope total: the directory read is capped at 200 rows.
    models: useAssetModelTotal().data,
    statuses: useAssetStatusLabels().data?.length,
    application: useApplicationCategories().data?.length,
    consumable: useConsumableCategories().data?.length,
  };
}

function TaxonomyPanes() {
  const t = useTranslations("settings.taxonomies");
  const [selection, select] = useTaxonomySelection();
  const counts = usePaneCounts();
  const paneTitle = (pane: TaxonomyPane) => t(`paneTitles.${pane}`);

  return (
    <div className="space-y-4 md:grid md:grid-cols-[14rem_minmax(0,1fr)] md:items-start md:gap-6 md:space-y-0">
      {/* ≥ md: the grouped list. */}
      <nav
        aria-label={t("listLabel")}
        className="hidden space-y-4 rounded-xl bg-card p-2 ring-1 ring-foreground/10 md:sticky md:top-4 md:block"
      >
        {TAXONOMY_GROUPS.map((group) => (
          <div key={group.key} className="space-y-0.5">
            <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              {t(`groups.${group.key}`)}
            </p>
            <ul className="space-y-px">
              {group.panes.map((pane) => {
                const current = selection === pane;
                return (
                  <li key={pane}>
                    <button
                      type="button"
                      onClick={() => select(pane)}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        current
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <TagIcon className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{t(`panes.${pane}`)}</span>
                      {counts[pane] !== undefined ? (
                        <span className="font-mono text-xs tabular-nums">{counts[pane]}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div className="space-y-0.5">
          <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            {t("groups.knowledge")}
          </p>
          <Link
            href={KB_HREF}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderIcon className="size-4 shrink-0" aria-hidden />
            {t("kbFolders")}
          </Link>
        </div>
      </nav>

      {/* < md: one picker instead of a column the width of the screen. */}
      <div className="md:hidden">
        <Select value={selection} onValueChange={(next) => select(next as TaxonomySelection)}>
          <SelectTrigger aria-label={t("listLabel")} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TAXONOMY_GROUPS.map((group) => (
              <SelectGroup key={group.key}>
                <SelectLabel>{t(`groups.${group.key}`)}</SelectLabel>
                {group.panes.map((pane) => (
                  <SelectItem key={pane} value={pane}>
                    {t(`panes.${pane}`)}
                    {counts[pane] !== undefined ? ` · ${counts[pane]}` : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectGroup>
              <SelectLabel>{t("groups.knowledge")}</SelectLabel>
              <SelectItem value="kb">{t("kbFolders")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="min-w-0">
        {selection === "kb" ? (
          <KbPointer />
        ) : selection === "models" ? (
          <AssetModelManager title={paneTitle("models")} />
        ) : selection === "statuses" ? (
          <AssetStatusLabelManager title={paneTitle("statuses")} />
        ) : (
          <CategoryManager key={selection} kind={selection} title={paneTitle(selection)} />
        )}
      </div>
    </div>
  );
}

/** The old "Article categories" tab: those categories are the KB folders, managed in the KB. */
function KbPointer() {
  const t = useTranslations("settings.taxonomies");
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10">
      <FolderIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">{t("kbPointer")}</p>
      <Button asChild variant="outline" size="sm">
        <Link href={KB_HREF}>
          {t("kbOpen")}
          <ArrowTopRightOnSquareIcon />
        </Link>
      </Button>
    </div>
  );
}
