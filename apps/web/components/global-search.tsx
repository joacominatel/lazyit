"use client";

import {
  BookOpenIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  ServerStackIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { SEARCH_ENTITIES, type SearchEntity } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSearch } from "@/lib/api/hooks/use-search";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

type EntityFilter = SearchEntity | "all";

/** Per-entity icon. The five searchable entities (ADR-0035) render in this order; the visible
 * label is resolved per render from the `shared.search.entities` namespace (the map key is the
 * entity value, kept as-is for the API). */
const ENTITY_ICON: Record<SearchEntity, typeof ServerStackIcon> = {
  assets: ServerStackIcon,
  articles: BookOpenIcon,
  users: UsersIcon,
  locations: MapPinIcon,
  applications: KeyIcon,
};

/**
 * Global search palette (ADR-0035). A topbar trigger (and ⌘K / Ctrl+K) opens a command dialog that
 * queries `GET /search`; results are grouped by entity and each navigates to that entity.
 *
 * Filtering is **server-side** — the Command runs with `shouldFilter={false}` and we render exactly
 * the hits the API returns; cmdk still provides the roving keyboard selection (↑/↓ + Enter). The
 * query is debounced (300ms) and gated on a non-empty input so an open-but-empty palette is silent.
 *
 * Navigation targets degrade gracefully where no detail page exists yet: Users → /users and
 * Locations → /locations (list); Applications → /applications/[id] is forward-compatible (the route
 * lands with the Access screen, sub-issue 2).
 */
export function GlobalSearch() {
  const t = useTranslations("shared");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState<EntityFilter>("all");

  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const entities = entity === "all" ? undefined : [entity];
  // Fewer per index when searching everything (keeps the palette compact); more when scoped.
  const limit = entity === "all" ? 5 : 12;

  const { data, isFetching, isError, error } = useSearch({
    q: debouncedQuery,
    entities,
    limit,
    enabled: open,
  });

  // ⌘K / Ctrl+K toggles the palette from anywhere in the app shell.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reset transient state on close (not in an effect) so a reopened palette starts clean.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setEntity("all");
    }
  }

  function go(href: string) {
    handleOpenChange(false);
    router.push(href);
  }

  const hasQuery = debouncedQuery.length > 0;
  // `degraded` (issue #370): the API is fail-soft, so a Meili outage returns an empty 200 — we surface
  // it as the error state ("search unavailable") instead of silently rendering "no results".
  const isDegraded = data?.degraded === true;
  const totalHits = data
    ? SEARCH_ENTITIES.reduce((sum, key) => sum + (data[key]?.hits.length ?? 0), 0)
    : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Below sm the trigger collapses to an icon-only square so the topbar
        // stays uncluttered on phones; from sm up it expands to the labelled
        // search affordance. aria-label keeps it named in the collapsed state.
        aria-label={t("search.trigger")}
        className="inline-flex size-9 shrink-0 items-center justify-center gap-2 rounded-md border border-input bg-background text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground sm:size-auto sm:h-9 sm:w-full sm:max-w-xs sm:justify-start sm:px-3"
      >
        <MagnifyingGlassIcon className="size-4 shrink-0" />
        <span className="hidden flex-1 text-left sm:inline">
          {t("search.placeholderShort")}
        </span>
        <kbd className="pointer-events-none hidden h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium sm:inline-flex">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="overflow-hidden p-0 sm:max-w-xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("search.globalTitle")}</DialogTitle>
            <DialogDescription>
              {t("search.globalDescription")}
            </DialogDescription>
          </DialogHeader>

          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("search.placeholderEverything")}
            />

            <div className="flex flex-wrap gap-1 border-b px-3 py-2">
              <FilterChip active={entity === "all"} onSelect={() => setEntity("all")}>
                {t("search.all")}
              </FilterChip>
              {SEARCH_ENTITIES.map((key) => (
                <FilterChip
                  key={key}
                  active={entity === key}
                  onSelect={() => setEntity(key)}
                >
                  {t(`search.entities.${key}`)}
                </FilterChip>
              ))}
            </div>

            {/* Politely announce result/status changes (count, empty, error)
                to assistive tech as the debounced query resolves (WCAG 4.1.3). */}
            <CommandList aria-live="polite">
              {!hasQuery ? (
                <StatusRow>{t("search.startTyping")}</StatusRow>
              ) : isError ? (
                <StatusRow tone="error">
                  {error instanceof Error && error.message
                    ? t("search.runErrorDetail", { message: error.message })
                    : `${t("search.runError")}.`}
                </StatusRow>
              ) : isDegraded ? (
                // The request succeeded (HTTP 200) but Meili was down — distinguish an outage from a
                // genuine empty result so the user retries rather than trusting "no results".
                <StatusRow tone="error">{t("search.unavailable")}</StatusRow>
              ) : (
                <>
                  <ResultGroup
                    entity="assets"
                    block={data?.assets}
                    onSelect={(hit) => go(`/assets/${hit.id}`)}
                    render={(hit) => ({
                      primary: hit.name,
                      secondary: hit.assetTag ?? hit.serial ?? undefined,
                    })}
                  />
                  <ResultGroup
                    entity="articles"
                    block={data?.articles}
                    onSelect={(hit) => go(`/kb/${hit.slug}`)}
                    render={(hit) => ({
                      primary: hit.title,
                      secondary: hit.excerpt ?? undefined,
                    })}
                  />
                  <ResultGroup
                    entity="users"
                    block={data?.users}
                    onSelect={() => go("/users")}
                    render={(hit) => ({
                      primary: `${hit.firstName} ${hit.lastName}`.trim(),
                      secondary: hit.email,
                    })}
                  />
                  <ResultGroup
                    entity="locations"
                    block={data?.locations}
                    onSelect={() => go("/locations")}
                    render={(hit) => ({
                      primary: hit.name,
                      secondary: hit.address ?? hit.type,
                    })}
                  />
                  <ResultGroup
                    entity="applications"
                    block={data?.applications}
                    onSelect={(hit) => go(`/applications/${hit.id}`)}
                    render={(hit) => ({
                      primary: hit.name,
                      secondary: hit.vendor ?? undefined,
                    })}
                  />
                  {totalHits === 0 &&
                    (isFetching ? (
                      <StatusRow>{t("search.searching")}</StatusRow>
                    ) : (
                      <StatusRow>
                        {t("search.noResultsFor", { query: debouncedQuery })}
                      </StatusRow>
                    ))}
                </>
              )}
            </CommandList>

            <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> {t("search.navigate")}
              </span>
              <span>
                <Kbd>↵</Kbd> {t("search.open")}
              </span>
              <span>
                <Kbd>esc</Kbd> {t("search.close")}
              </span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A muted (or destructive) full-width status row used for the empty / loading / error states. */
function StatusRow({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "px-3 py-8 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** A toggle chip scoping the search to one entity (or "all"). Keeps the input focused on click. */
function FilterChip({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      // Don't steal focus from the search input — let typing/▲▼ continue after a chip click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border bg-muted px-1 font-mono text-[10px]">
      {children}
    </kbd>
  );
}

/**
 * One entity's result section. Generic over the hit type `H` so `render`/`onSelect` are typed to the
 * concrete hit (asset, article, …). Renders nothing when the block is absent or empty, so a scoped
 * search (only one entity key present) collapses the rest.
 */
function ResultGroup<H extends { id: string }>({
  entity,
  block,
  render,
  onSelect,
}: {
  entity: SearchEntity;
  block: { hits: H[]; total: number } | undefined;
  render: (hit: H) => { primary: string; secondary?: string };
  onSelect: (hit: H) => void;
}) {
  const t = useTranslations("shared");
  if (!block || block.hits.length === 0) return null;
  const label = t(`search.entities.${entity}`);
  const Icon = ENTITY_ICON[entity];
  const more = block.total > block.hits.length ? ` · ${block.total}` : "";

  return (
    <CommandGroup heading={`${label}${more}`}>
      {block.hits.map((hit) => {
        const { primary, secondary } = render(hit);
        return (
          <CommandItem
            key={`${entity}:${hit.id}`}
            value={`${entity}:${hit.id}`}
            onSelect={() => onSelect(hit)}
            className="gap-2"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{primary}</span>
            {secondary ? (
              <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                {secondary}
              </span>
            ) : null}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
