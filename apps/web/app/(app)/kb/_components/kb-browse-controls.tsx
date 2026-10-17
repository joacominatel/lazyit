"use client";

import {
  ArrowUpTrayIcon,
  BarsArrowDownIcon,
  ChevronDownIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { ArticleListSort } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { KB_SORTS, type KbStatusSegment, parseKbSort } from "@/lib/utils/kb-browse";
import { ImportArticleDialog } from "./import-article-dialog";

/** Stable id on the inline search box so the `/` shortcut can focus it from a document-level handler. */
export const KB_SEARCH_INPUT_ID = "kb-search-input";

/**
 * The KB search box — the strong Meilisearch body search (#1106 Phase 3) — with its keyboard hints:
 * `/` focuses it (unless already typing in a field), ⌘K opens the KB quick-switcher (registered by
 * the shell). The hints show only while the box is empty and the screen is wide enough for them.
 */
export function KbSearchBar({
  value,
  onSearch,
}: {
  value: string;
  onSearch: (query: string) => void;
}) {
  const t = useTranslations("kb");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      const input = document.getElementById(KB_SEARCH_INPUT_ID) as HTMLInputElement | null;
      if (input) {
        event.preventDefault();
        input.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="group/search relative">
      <SearchInput
        id={KB_SEARCH_INPUT_ID}
        value={value}
        debounceMs={300}
        onDebouncedChange={onSearch}
        label={t("list.searchLabel")}
        placeholder={t("list.searchPlaceholder")}
        className="[&_input]:h-10"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 items-center gap-1 sm:group-has-[input:placeholder-shown]/search:flex"
      >
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">/</kbd>
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">⌘K</kbd>
      </span>
    </div>
  );
}

/**
 * The status segmented control (All / Published / Drafts) with per-status counts (#1539). A group of
 * toggle buttons (`aria-pressed`) — it filters the list, it does not switch panels. Counts render only
 * once known.
 */
export function StatusSegmented({
  value,
  onChange,
  counts,
}: {
  value: KbStatusSegment;
  onChange: (next: KbStatusSegment) => void;
  counts: { all?: number; published?: number; drafts?: number };
}) {
  const t = useTranslations("kb");
  const options: { value: KbStatusSegment; label: string; count?: number }[] = [
    { value: "all", label: t("segment.all"), count: counts.all },
    { value: "PUBLISHED", label: t("segment.published"), count: counts.published },
    { value: "DRAFT", label: t("segment.drafts"), count: counts.drafts },
  ];
  return (
    <div
      role="group"
      aria-label={t("segment.label")}
      className="inline-flex items-center rounded-lg bg-muted p-0.5"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[0.8rem] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-background font-medium text-foreground shadow-xs ring-1 ring-foreground/10",
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The Sort dropdown (Updated / Title / Created) writing the `sort` URL param (#1539). */
export function SortMenu({
  value,
  onChange,
}: {
  value: ArticleListSort;
  onChange: (next: ArticleListSort) => void;
}) {
  const t = useTranslations("kb");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t("sort.ariaLabel", { value: t(`sort.${value}`) })}>
          <BarsArrowDownIcon />
          {t(`sort.${value}`)}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t("sort.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(parseKbSort(next))}
        >
          {KB_SORTS.map((sort) => (
            <DropdownMenuRadioItem key={sort} value={sort}>
              {t(`sort.${sort}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Import + New article — both create an article, so both gate on `article:write`. */
export function KbCreateActions() {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const canWrite = useCan("article:write");
  const [importOpen, setImportOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setImportOpen(true)}>
        <ArrowUpTrayIcon />
        {tc("import")}
      </Button>
      <Button asChild>
        <Link href="/kb/new">
          <PlusIcon />
          {t("list.newArticle")}
        </Link>
      </Button>
      <ImportArticleDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
