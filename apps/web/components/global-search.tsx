"use client";

import {
  BookOpenIcon,
  CpuChipIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  ServerStackIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { EyeIcon } from "@heroicons/react/16/solid";
import {
  type AssetHit,
  type AssetStatus,
  type InfraNodeHit,
  type InfraNodeKind,
  type InfraNodeStatus,
  type LocationType,
  SEARCH_ENTITIES,
  type SearchEntity,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { quickViewChordKeyDown } from "@/components/quick-view-eye";
import { type QuickViewData, titleFor } from "@/components/quick-view-fields";
import { QuickViewPopover } from "@/components/quick-view-popover";
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
import { useAsset } from "@/lib/api/hooks/use-assets";
import { useSearch } from "@/lib/api/hooks/use-search";
import { useUser } from "@/lib/api/hooks/use-users";
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
  infra: CpuChipIcon,
};

/** The lifted single-open Quick View state: which row's preview is open and whether it's pinned.
 *  Grouped into a reducer so the palette stays under the prefer-useReducer budget (open/query/entity
 *  remain their own state). The transitions mirror the original setOpenQuickViewId/setQuickViewPinned
 *  pairs exactly. */
type QuickViewLocalState = { openId: string | null; pinned: boolean };
type QuickViewLocalAction =
  | { type: "preview"; id: string }
  | { type: "pin"; id: string }
  | { type: "close" };
function quickViewReducer(
  state: QuickViewLocalState,
  action: QuickViewLocalAction,
): QuickViewLocalState {
  switch (action.type) {
    case "preview":
      return { openId: action.id, pinned: false };
    case "pin":
      return { openId: action.id, pinned: true };
    case "close":
      return { openId: null, pinned: false };
  }
}

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

  // Quick View (epic #788, wave 3 — ADR-0072): lifted here so only ONE preview is open at a time
  // across every result row, and a pinned preview survives the cmdk selection moving. The id is the
  // namespaced row key (`entity:id`) so two entities can't collide on a bare id. `pinned` separates a
  // transient hover preview (auto-closes on leave) from a click/Enter/Space-pinned one (footer shown).
  const [quickView, dispatchQuickView] = useReducer(quickViewReducer, {
    openId: null,
    pinned: false,
  });

  function closeQuickView() {
    dispatchQuickView({ type: "close" });
  }

  // Bundle the single-open state + transitions once, so each ResultGroup wires its rows identically.
  const quickViewState: QuickViewState = {
    openId: quickView.openId,
    pinned: quickView.pinned,
    preview: (id) => dispatchQuickView({ type: "preview", id }),
    pin: (id) => dispatchQuickView({ type: "pin", id }),
    close: closeQuickView,
  };

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
      // A preview is anchored to a row that's about to unmount — dismiss it with the palette.
      closeQuickView();
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
    ? SEARCH_ENTITIES.reduce(
        (sum, key) => sum + (data[key]?.hits.length ?? 0),
        0,
      )
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
        <kbd className="pointer-events-none hidden h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-xs font-medium sm:inline-flex">
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
            // Keyboard-open path (#793): Alt+Enter pins the highlighted result's preview. cmdk runs this
            // before its own handler and the chord preventDefaults, so ↑/↓ nav, typing and plain
            // Enter-to-open stay untouched.
            onKeyDown={(event) =>
              quickViewChordKeyDown(event, quickViewState.pin)
            }
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("search.placeholderEverything")}
            />

            <div className="flex flex-wrap gap-1 border-b px-3 py-2">
              <FilterChip
                active={entity === "all"}
                onSelect={() => setEntity("all")}
              >
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
                  {/* Each group gets the lifted single-open Quick View state. The eye opens a preview
                      of that row WITHOUT firing its `onSelect` navigation (the eye stopPropagations).
                      Most entities build the preview from the lean hit itself (zero extra fetch);
                      assets lazily fetch the rich detail on open (`AssetQuickViewEye`) since the hit
                      lacks the model/category/location/owner disambiguators. */}
                  <ResultGroup
                    entity="assets"
                    block={data?.assets}
                    onSelect={(hit) => go(`/assets/${hit.id}`)}
                    render={(hit) => ({
                      primary: hit.name,
                      secondary: hit.assetTag ?? hit.serial ?? undefined,
                    })}
                    quickViewState={quickViewState}
                    Eye={AssetQuickViewEye}
                  />
                  <ResultGroup
                    entity="articles"
                    block={data?.articles}
                    onSelect={(hit) => go(`/kb/${hit.slug}`)}
                    render={(hit) => ({
                      primary: hit.title,
                      secondary: hit.excerpt ?? undefined,
                    })}
                    quickViewState={quickViewState}
                    quickView={(hit) => ({
                      entity: "article",
                      data: {
                        id: hit.id,
                        title: hit.title,
                        slug: hit.slug,
                        status:
                          hit.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT",
                        excerpt: hit.excerpt,
                      },
                    })}
                  />
                  {/* CEO decision (#779): user/location hits land on the pre-filtered list
                      (search-then-browse) — carry the typed query as `?q=` so the list arrives
                      filtered and the search input hydrates from the URL on mount. */}
                  <ResultGroup
                    entity="users"
                    block={data?.users}
                    onSelect={() => go(`/users?q=${encodeURIComponent(query)}`)}
                    render={(hit) => ({
                      primary: `${hit.firstName} ${hit.lastName}`.trim(),
                      secondary: hit.email,
                    })}
                    quickViewState={quickViewState}
                    Eye={UserQuickViewEye}
                  />
                  <ResultGroup
                    entity="locations"
                    block={data?.locations}
                    onSelect={() =>
                      go(`/locations?q=${encodeURIComponent(query)}`)
                    }
                    render={(hit) => ({
                      primary: hit.name,
                      secondary: hit.address ?? hit.type,
                    })}
                    quickViewState={quickViewState}
                    quickView={(hit) => ({
                      entity: "location",
                      // The hit already carries type/address/floor — the full preview, no fetch.
                      data: {
                        id: hit.id,
                        name: hit.name,
                        type: isLocationType(hit.type) ? hit.type : "OTHER",
                        address: hit.address,
                        floor: hit.floor,
                        description: null,
                        notes: null,
                        createdAt: "",
                        updatedAt: "",
                        deletedAt: null,
                      },
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
                    quickViewState={quickViewState}
                    quickView={(hit) => ({
                      entity: "application",
                      // The hit carries vendor + description (the useful preview); url isn't indexed and
                      // isn't worth a per-open fetch. SEC-008 stays satisfied — no url is shown at all.
                      data: {
                        id: hit.id,
                        name: hit.name,
                        description: hit.description,
                        url: null,
                        vendor: hit.vendor,
                        categoryId: null,
                        isCritical: false,
                        metadata: null,
                        notes: null,
                        createdAt: "",
                        updatedAt: "",
                        deletedAt: null,
                      },
                    })}
                  />
                  <ResultGroup
                    entity="infra"
                    block={data?.infra}
                    onSelect={(hit) =>
                      go(`/assets/diagram?node=${hit.id}&focus=1`)
                    }
                    render={(hit) => ({
                      primary: hit.label,
                      secondary: hit.assetName ?? hit.ipAddress ?? undefined,
                    })}
                    quickViewState={quickViewState}
                    quickView={(hit) => infraViewFromHit(hit)}
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

            <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> {t("search.navigate")}
              </span>
              <span>
                <Kbd>↵</Kbd> {t("search.open")}
              </span>
              <span>
                <Kbd>alt</Kbd>
                <Kbd>↵</Kbd> {t("search.preview")}
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
    <kbd className="mx-0.5 rounded border bg-muted px-1 font-mono text-xs">
      {children}
    </kbd>
  );
}

/**
 * The lifted, single-open Quick View interaction shared by every result row (ADR-0072, wave 3). One
 * preview open at a time across the whole palette; a pinned one survives the cmdk selection moving.
 * `openId` is the namespaced row key (`entity:id`). The transitions take that key so a hover preview,
 * a click-pin and Escape/outside-click all collapse to the one lifted state.
 */
interface QuickViewState {
  openId: string | null;
  pinned: boolean;
  preview: (id: string) => void;
  pin: (id: string) => void;
  close: () => void;
}

/** The eye-state slice a per-row eye needs (already narrowed to THIS row's open/pinned booleans). */
interface RowEyeState {
  open: boolean;
  pinned: boolean;
  onPreview: () => void;
  onPin: () => void;
  onClose: () => void;
}

/** A per-row eye component: builds the (possibly lazily-fetched) {@link QuickViewData} for one hit. */
type EyeComponent<H> = (props: { hit: H; eye: RowEyeState }) => ReactNode;

/**
 * One entity's result section. Generic over the hit type `H` so `render`/`onSelect` are typed to the
 * concrete hit (asset, article, …). Renders nothing when the block is absent or empty, so a scoped
 * search (only one entity key present) collapses the rest.
 *
 * Quick View (wave 3): each row gains a focusable eye (revealed on hover or on the cmdk-selected row)
 * that previews the entity WITHOUT firing `onSelect`. A group supplies EITHER `quickView` — a pure
 * hit→{@link QuickViewData} mapper for entities the lean hit already disambiguates (zero fetch) — OR a
 * custom `Eye` component for entities that lazily fetch their detail on open (assets, users). Omit
 * both and the row renders eyeless (unchanged).
 */
function ResultGroup<H extends { id: string }>({
  entity,
  block,
  render,
  onSelect,
  quickViewState,
  quickView,
  Eye,
}: {
  entity: SearchEntity;
  block: { hits: H[]; total: number } | undefined;
  render: (hit: H) => { primary: string; secondary?: string };
  onSelect: (hit: H) => void;
  quickViewState?: QuickViewState;
  quickView?: (hit: H) => QuickViewData | null;
  Eye?: EyeComponent<H>;
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
        const rowId = `${entity}:${hit.id}`;
        // Narrow the lifted state to THIS row so the eye only knows its own open/pinned booleans.
        const eye: RowEyeState | null = quickViewState
          ? {
              open: quickViewState.openId === rowId,
              pinned: quickViewState.openId === rowId && quickViewState.pinned,
              onPreview: () => quickViewState.preview(rowId),
              onPin: () => quickViewState.pin(rowId),
              onClose: quickViewState.close,
            }
          : null;
        const fromHit = quickView?.(hit) ?? null;
        return (
          <CommandItem
            key={rowId}
            value={rowId}
            // Robust highlighted→id mapping for the Alt+Enter chord (#793): stamp the namespaced row id
            // (only when the row has an openable eye) so quickViewChordKeyDown reads it off the DOM.
            data-quick-view-id={Eye || fromHit ? rowId : undefined}
            onSelect={() => onSelect(hit)}
            // `group/row` so the eye reveals on hover OR on the cmdk-selected row (keyboard roving).
            className="group/row gap-2"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{primary}</span>
            {secondary ? (
              <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                {secondary}
              </span>
            ) : null}
            {eye ? (
              <span
                className={cn("shrink-0", secondary ? "pl-1" : "ml-auto pl-3")}
              >
                {Eye ? (
                  <Eye hit={hit} eye={eye} />
                ) : fromHit ? (
                  <QuickViewEye view={fromHit} {...eye} />
                ) : null}
              </span>
            ) : null}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

/** Intent delay (ms) before a hover opens the Quick View preview — long enough that skimming the
 *  list with the mouse doesn't flicker previews, short enough to feel instant on a deliberate hover.
 *  Matches the picker affordance (combobox.tsx). */
const QUICK_VIEW_HOVER_MS = 120;

/**
 * The per-row eye affordance (ADR-0072), mirroring the picker's `QuickViewEye` (combobox.tsx). A real
 * `<button>` that is `opacity-0` and revealed by `group-hover/row` OR `group-data-[selected=true]/row`
 * — so it is keyboard-VISIBLE on the cmdk-selected row, not just on mouse hover. It
 * `stopPropagation`/`preventDefault`s so activating it NEVER triggers the row's `onSelect` navigation.
 *
 * Hover (after a ~120ms intent delay) opens a transient PREVIEW; click PINS it (footer + dialog
 * semantics). It is the radix `PopoverAnchor`, so Escape closes + returns focus to the cmdk input
 * (QuickViewPopover restores it).
 *
 * KEYBOARD-OPEN (#793, same as the pickers): the eye is `tabIndex={-1}` (cmdk owns roving focus — DOM
 * focus stays on the CommandInput). The keyboard path is the non-conflicting Alt+Enter chord wired on
 * the palette's `<Command>` root (`quickViewChordKeyDown`), which opens + pins the HIGHLIGHTED row's
 * preview without fighting that roving model; `aria-keyshortcuts` advertises it to AT.
 */
function QuickViewEye({
  view,
  open,
  pinned,
  onPreview,
  onPin,
  onClose,
}: { view: QuickViewData } & RowEyeState) {
  const t = useTranslations("common.quickView");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  // Stable element for QuickViewPopover's `anchor` slot (jsx-no-jsx-as-prop).
  const anchor = useMemo(
    () => (
      <button
        type="button"
        aria-label={t("trigger", { name: titleFor(view) })}
        // The Alt+Enter chord (quickViewChordKeyDown on the Command root) opens this row's preview by
        // keyboard; advertise it to AT on the control it activates (#793).
        aria-keyshortcuts="Alt+Enter"
        // cmdk owns roving focus (DOM focus stays on the CommandInput); keep the eye out of the Tab
        // order so it doesn't fight that model — the keyboard path is the chord, not a Tab stop.
        tabIndex={-1}
        className={cn(
          "flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100",
          open && "opacity-100",
        )}
        onMouseEnter={() => {
          clearHoverTimer();
          hoverTimer.current = setTimeout(onPreview, QUICK_VIEW_HOVER_MS);
        }}
        onMouseLeave={() => {
          clearHoverTimer();
          // Only a transient preview auto-dismisses on leave; a pinned one stays.
          if (open && !pinned) onClose();
        }}
        onClick={(event) => {
          // Don't let the click bubble to cmdk and select the row — the eye is a separate action.
          event.preventDefault();
          event.stopPropagation();
          clearHoverTimer();
          // Toggle: clicking the eye of an already-pinned preview closes it.
          if (open && pinned) onClose();
          else onPin();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            clearHoverTimer();
            if (open && pinned) onClose();
            else onPin();
          }
        }}
      >
        <EyeIcon className="size-4" />
      </button>
    ),
    [t, view, open, pinned, onPreview, onPin, onClose, clearHoverTimer],
  );

  return (
    <QuickViewPopover
      view={view}
      open={open}
      pinned={pinned}
      onOpenChange={(next) => {
        // Radix drives this on Escape / outside-click — collapse our lifted state to match.
        if (!next) onClose();
      }}
      anchor={anchor}
    />
  );
}

/**
 * Asset eye — the one palette entity whose lean hit (name/serial/assetTag/status) lacks the headline
 * disambiguators (model, category, location, OWNER). It lazily fetches the rich detail via `useAsset`
 * gated on the preview being open (`enabled: open`) — one deduped/cached request per opened item,
 * never on row render, never list-wide. The lean hit renders instantly; the detail enriches it when it
 * lands (TanStack dedup + the warm detail cache from a prior open/navigation make repeats instant).
 */
function AssetQuickViewEye({ hit, eye }: { hit: AssetHit; eye: RowEyeState }) {
  const { data } = useAsset(eye.open ? hit.id : undefined);
  const view: QuickViewData = {
    entity: "asset",
    data: data
      ? {
          // The detail read (AssetWithRelations) is a structural superset of AssetListItem; map only
          // the fields the presenter reads so the slot stays exactly the list-item shape it expects.
          id: data.id,
          name: data.name,
          serial: data.serial,
          assetTag: data.assetTag,
          status: data.status,
          notes: data.notes,
          company: data.company,
          purchaseDate: data.purchaseDate,
          warrantyEnd: data.warrantyEnd,
          modelId: data.modelId,
          locationId: data.locationId,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          deletedAt: data.deletedAt,
          model: data.model
            ? {
                id: data.model.id,
                name: data.model.name,
                manufacturer: data.model.manufacturer,
                category: data.model.category
                  ? {
                      id: data.model.category.id,
                      name: data.model.category.name,
                    }
                  : null,
              }
            : null,
          location: data.location
            ? {
                id: data.location.id,
                name: data.location.name,
                type: data.location.type,
              }
            : null,
          activeAssignments: data.activeAssignments.map((a) => ({
            id: a.id,
            userId: a.userId,
            user: {
              id: a.user.id,
              firstName: a.user.firstName,
              lastName: a.user.lastName,
              email: a.user.email,
              deletedAt: a.user.deletedAt,
            },
          })),
        }
      : {
          // Instant skeleton from the lean hit while the detail loads (serial/tag/status show now).
          id: hit.id,
          name: hit.name,
          serial: hit.serial,
          assetTag: hit.assetTag,
          status: isAssetStatus(hit.status) ? hit.status : "UNKNOWN",
          notes: hit.notes,
          company: null,
          purchaseDate: null,
          warrantyEnd: null,
          modelId: null,
          locationId: null,
          createdAt: "",
          updatedAt: "",
          deletedAt: null,
          model: null,
          location: null,
          activeAssignments: [],
        },
  };
  return <QuickViewEye view={view} {...eye} />;
}

/**
 * User eye — the lean hit (id/name/email) is enough to render the avatar + email identity instantly,
 * but the identity badge (active/inactive + RBAC role) and the username/legajo/manager fields aren't
 * on the search index, so it would fabricate a (wrong) badge from the hit. So it lazily fetches the
 * bare `User` via `useUser` (gated on open) for the correct role/status/details, showing the hit
 * identity while it loads. `User` is a structural `UserListItem` (the activity counts are optional).
 */
function UserQuickViewEye({
  hit,
  eye,
}: {
  hit: { id: string; firstName: string; lastName: string; email: string };
  eye: RowEyeState;
}) {
  const { data } = useUser(eye.open ? hit.id : undefined);
  const view: QuickViewData = {
    entity: "user",
    data: data ?? {
      // Identity-only skeleton from the hit while the detail loads. The role/status badge waits for
      // the fetch rather than guessing — `MEMBER`/active here would be a misleading default, so we
      // keep them off until the real values arrive (the badge simply renders from these once `data`
      // replaces this object).
      id: hit.id,
      firstName: hit.firstName,
      lastName: hit.lastName,
      email: hit.email,
      isActive: true,
      role: "MEMBER",
      externalId: null,
      legajo: null,
      username: null,
      manager: null,
      directoryOnly: false,
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
    },
  };
  return <QuickViewEye view={view} {...eye} />;
}

/** Build the infra Quick View straight from the lean hit — kind/status/IP/linked-asset are all on the
 *  index (zero extra fetch). Narrows the index's plain-string `kind`/`status` back to their enums. */
function infraViewFromHit(hit: InfraNodeHit): QuickViewData {
  return {
    entity: "infra",
    data: {
      id: hit.id,
      label: hit.label,
      kind: isInfraKind(hit.kind) ? hit.kind : "OTHER",
      status: isInfraStatus(hit.status) ? hit.status : "UNKNOWN",
      ipAddress: hit.ipAddress,
      assetName: hit.assetName,
    },
  };
}

const ASSET_STATUSES = new Set<string>([
  "OPERATIONAL",
  "IN_MAINTENANCE",
  "IN_STORAGE",
  "RETIRED",
  "LOST",
  "UNKNOWN",
]);
function isAssetStatus(v: string): v is AssetStatus {
  return ASSET_STATUSES.has(v);
}

const LOCATION_TYPES = new Set<string>([
  "OFFICE",
  "DATACENTER",
  "RACK",
  "REMOTE",
  "STORAGE",
  "OTHER",
]);
function isLocationType(v: string): v is LocationType {
  return LOCATION_TYPES.has(v);
}

const INFRA_KINDS = new Set<string>([
  "PHYSICAL_HOST",
  "VM",
  "CONTAINER",
  "CLUSTER",
  "NETWORK_DEVICE",
  "STORAGE",
  "APPLIANCE",
  "OTHER",
]);
function isInfraKind(v: string): v is InfraNodeKind {
  return INFRA_KINDS.has(v);
}

const INFRA_STATUSES = new Set<string>(["ONLINE", "OFFLINE", "UNKNOWN"]);
function isInfraStatus(v: string): v is InfraNodeStatus {
  return INFRA_STATUSES.has(v);
}
