"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { AdminGate } from "../_components/admin-gate";
import { AssetModelManager } from "../_components/asset-model-manager";
import { AssetStatusLabelManager } from "../_components/asset-status-label-manager";
import { CategoryManager } from "../_components/category-manager";
import { parseTaxonomyTab, TAXONOMY_TABS, type TaxonomyTab } from "../_components/taxonomy-tabs";

/** Stable empty breadcrumb for the taxonomies page PageHeader. */

/**
 * Settings → Taxonomies. A single screen with a tab bar over the four category kinds, asset models and
 * the custom asset statuses (ADR-0101), each backed by its own manager. Lean local tabs (no shadcn Tabs in
 * the kit yet) keep this consistent with the rest of the app's chrome.
 *
 * The tab lives in the URL (`?tab=statuses`) so a tab can be linked to — the AI assistant links a custom
 * status there. No param (or an unknown one) is the first tab, as before.
 */
// ponytail: skipped from the ADR-0067 server-prefetch rollout — a tab-state shell whose primary read
// is a tab-dependent child (CategoryManager kind varies / AssetModelManager); no single stable
// first-paint query to prefetch.
export default function TaxonomiesPage() {
  const t = useTranslations("settings");
  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("taxonomies.title")}
          subtitle={t("taxonomies.subtitle")}
        />
        {/* `useSearchParams` needs a Suspense boundary on a client page (the ?tab= deep link). */}
        <Suspense fallback={null}>
          <TaxonomyTabs />
        </Suspense>
      </div>
    </AdminGate>
  );
}

function TaxonomyTabs() {
  const t = useTranslations("settings");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseTaxonomyTab(searchParams.get("tab"));

  function selectTab(key: TaxonomyTab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <>
      <div className="border-b">
        <div
          role="tablist"
          aria-label={t("taxonomies.tablistAria")}
          className="-mb-px flex flex-wrap gap-1"
        >
          {TAXONOMY_TABS.map((key) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(key)}
                className={cn(
                  "border-b-2 px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`taxonomies.tabs.${key}`)}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "models" ? (
        <AssetModelManager />
      ) : tab === "statuses" ? (
        <AssetStatusLabelManager />
      ) : (
        <CategoryManager kind={tab} />
      )}
    </>
  );
}
