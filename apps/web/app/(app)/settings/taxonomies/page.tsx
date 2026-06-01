"use client";

import { useState } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { AdminGate } from "../_components/admin-gate";
import { AssetModelManager } from "../_components/asset-model-manager";
import { CategoryManager } from "../_components/category-manager";

/** The five taxonomy surfaces — the four category kinds plus asset models. */
const TABS = [
  { key: "asset", label: "Asset categories" },
  { key: "application", label: "Application categories" },
  { key: "consumable", label: "Consumable categories" },
  { key: "article", label: "Article categories" },
  { key: "models", label: "Asset models" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * Settings → Taxonomies. A single screen with a tab bar over the four category kinds and asset
 * models, each backed by its own CRUD manager. Lean local tabs (no shadcn Tabs in the kit yet) keep
 * this consistent with the rest of the app's chrome.
 */
export default function TaxonomiesPage() {
  const [tab, setTab] = useState<TabKey>("asset");

  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title="Taxonomies"
          subtitle="Manage the categories that classify records, plus the asset models assets reference."
          breadcrumb={<Breadcrumb />}
        />

        <div className="border-b">
          <div
            role="tablist"
            aria-label="Taxonomy kind"
            className="-mb-px flex flex-wrap gap-1"
          >
            {TABS.map(({ key, label }) => {
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
                  {label}
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
