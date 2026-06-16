"use client";

import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchManual, type ManualSearchEntry } from "@/lib/manual/search";
import type { ManualCategory } from "@/lib/manual/types";
import { cn } from "@/lib/utils";
import { HelpNav } from "./help-nav";

/**
 * The Help sidebar's SIMPLE, client-side search (ADR-0062 §6 — explicitly NOT Meilisearch; full-text
 * search is deferred). A search box at the top of the sidebar filters the build-time `index` in memory
 * as the user types — accent-insensitive, title-first — via the pure `searchManual`. NO network call.
 *
 * While the query is empty the component renders the full `<HelpNav>` (nested category → subcategory
 * → pages, active page highlighted). Once the user types, it swaps the nav for a flat results list
 * linking to `/help/<slug>`, with a clean "no results" state. The `index` and `categories` are plain
 * props passed down from the Server Component layout.
 */
export function HelpSearch({
  index,
  categories,
  onNavigate,
}: {
  index: ManualSearchEntry[];
  categories: ManualCategory[];
  onNavigate?: () => void;
}) {
  const t = useTranslations("help");
  const [query, setQuery] = useState("");
  const inputId = useId();
  const trimmed = query.trim();
  const searching = trimmed !== "";

  // `searchManual` is pure + cheap, but memoize so we don't re-rank on every unrelated re-render.
  const results = useMemo(
    () => (searching ? searchManual(index, trimmed) : []),
    [index, trimmed, searching],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="relative px-1">
        <MagnifyingGlassIcon
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={inputId}
          type="search"
          role="searchbox"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          className="h-9 pl-9 pr-9"
        />
        {searching && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setQuery("")}
            aria-label={t("search.clear")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          >
            <XMarkIcon className="size-4" />
          </Button>
        )}
      </div>

      {searching ? (
        <HelpSearchResults results={results} onNavigate={onNavigate} />
      ) : (
        <HelpNav categories={categories} onNavigate={onNavigate} />
      )}
    </div>
  );
}

/** The flat, ranked search results (or the no-results state). Linkifies each hit to `/help/<slug>`. */
function HelpSearchResults({
  results,
  onNavigate,
}: {
  results: ReturnType<typeof searchManual>;
  onNavigate?: () => void;
}) {
  const t = useTranslations("help");

  if (results.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">
        {t("search.noResults")}
      </p>
    );
  }

  return (
    <nav aria-label={t("search.resultsLabel")}>
      <ul className="flex flex-col gap-0.5">
        {results.map(({ entry }) => (
          <li key={entry.slug}>
            <Link
              href={`/help/${entry.slug}`}
              onClick={onNavigate}
              className={cn(
                "flex flex-col gap-0.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <span className="font-medium text-foreground">{entry.title}</span>
              <span className="text-xs text-muted-foreground/80">
                {entry.category} · {entry.subcategory}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
