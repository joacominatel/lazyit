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

/** Per-entity label + icon. The five searchable entities (ADR-0035) render in this order. */
const ENTITY_META: Record<
  SearchEntity,
  { label: string; icon: typeof ServerStackIcon }
> = {
  assets: { label: "Assets", icon: ServerStackIcon },
  articles: { label: "Articles", icon: BookOpenIcon },
  users: { label: "Users", icon: UsersIcon },
  locations: { label: "Locations", icon: MapPinIcon },
  applications: { label: "Applications", icon: KeyIcon },
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
  const totalHits = data
    ? SEARCH_ENTITIES.reduce((sum, key) => sum + (data[key]?.hits.length ?? 0), 0)
    : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 w-full max-w-xs items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <MagnifyingGlassIcon className="size-4 shrink-0" />
        <span className="flex-1 text-left">Search…</span>
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
            <DialogTitle>Global search</DialogTitle>
            <DialogDescription>
              Search assets, articles, users, locations and applications.
            </DialogDescription>
          </DialogHeader>

          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search everything…"
            />

            <div className="flex flex-wrap gap-1 border-b px-3 py-2">
              <FilterChip active={entity === "all"} onSelect={() => setEntity("all")}>
                All
              </FilterChip>
              {SEARCH_ENTITIES.map((key) => (
                <FilterChip
                  key={key}
                  active={entity === key}
                  onSelect={() => setEntity(key)}
                >
                  {ENTITY_META[key].label}
                </FilterChip>
              ))}
            </div>

            <CommandList>
              {!hasQuery ? (
                <StatusRow>Start typing to search…</StatusRow>
              ) : isError ? (
                <StatusRow tone="error">
                  Couldn&apos;t run the search
                  {error instanceof Error && error.message
                    ? `: ${error.message}`
                    : "."}
                </StatusRow>
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
                      <StatusRow>Searching…</StatusRow>
                    ) : (
                      <StatusRow>No results for “{debouncedQuery}”.</StatusRow>
                    ))}
                </>
              )}
            </CommandList>

            <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span>
                <Kbd>↵</Kbd> open
              </span>
              <span>
                <Kbd>esc</Kbd> close
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
  if (!block || block.hits.length === 0) return null;
  const { label, icon: Icon } = ENTITY_META[entity];
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
