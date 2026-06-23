"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { AdminGate } from "../_components/admin-gate";
import { AssetModelManager } from "../_components/asset-model-manager";
import { CategoryManager } from "../_components/category-manager";

/** The five taxonomy surfaces — the four category kinds plus asset models. The visible label is
 * translated at render via `settings.taxonomies.tabs.<key>`. */
const TAB_KEYS = [
  "asset",
  "application",
  "consumable",
  "article",
  "models",
] as const;

type TabKey = (typeof TAB_KEYS)[number];

/**
 * Settings → Taxonomies. A single screen with a tab bar over the four category kinds and asset
 * models, each backed by its own CRUD manager. Lean local tabs (no shadcn Tabs in the kit yet) keep
 * this consistent with the rest of the app's chrome.
 */
// ponytail: skipped from the ADR-0067 server-prefetch rollout — a tab-state shell whose primary read
// is a tab-dependent child (CategoryManager kind varies / AssetModelManager); no single stable
// first-paint query to prefetch.
export default function TaxonomiesPage() {
  const t = useTranslations("settings");
  const [tab, setTab] = useState<TabKey>("asset");

  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("taxonomies.title")}
          subtitle={t("taxonomies.subtitle")}
          breadcrumb={<Breadcrumb />}
        />

        <div className="border-b">
          <div
            role="tablist"
            aria-label={t("taxonomies.tablistAria")}
            className="-mb-px flex flex-wrap gap-1"
          >
            {TAB_KEYS.map((key) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(key)}
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
        ) : (
          <CategoryManager kind={tab} />
        )}
      </div>
    </AdminGate>
  );
}
