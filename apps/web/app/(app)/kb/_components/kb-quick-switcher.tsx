"use client";

import { BookOpenIcon } from "@heroicons/react/24/outline";
import type { ArticleHit } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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

/**
 * The KB-scoped ⌘K quick-switcher (#1106 Phase 3). Reuses the exact strong-search rail as the visible
 * box — Meilisearch body full-text via `useSearch({ entities: ["articles"] })` (ADR-0035, folder-access
 * filtered server-side) — as a compact command palette: type → ↑/↓ → Enter jumps to `/kb/<slug>`. It
 * lives in the persistent KB shell, so it works from both the browse list and a reading page.
 *
 * ⌘K binding: the app shell's GLOBAL cross-entity palette also binds ⌘K app-wide. To make ⌘K
 * article-scoped INSIDE /kb without either duplicating that palette or fighting its listener, this
 * registers a CAPTURE-phase `keydown` handler and `stopImmediatePropagation()`s the combo — capture
 * runs before the global bubble listener on the same node, so while this component is mounted (only on
 * /kb, per the shell) our scoped palette shadows the global one; on unmount the global ⌘K is restored.
 * // ponytail: spec-clean capture-phase shadow — no coupling to the global palette's internals, no new
 * // global state/context, and it self-heals on route change (mount/unmount).
 *
 * Degrade-aware (#370): a Meili outage / not-yet-reindexed index surfaces "search unavailable" rather
 * than a misleading "no results" — the inline box carries the server title/excerpt fallback for the
 * primary browse surface; the modal switcher just reports the outage.
 */
export function KbQuickSwitcher() {
  const t = useTranslations("kb");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 250);

  const { data, isFetching, isError } = useSearch({
    q: debounced,
    entities: ["articles"],
    limit: 12,
    enabled: open,
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Shadow the app shell's global ⌘K (bubble-phase) while /kb is mounted — see the header note.
        event.stopImmediatePropagation();
        setOpen((prev) => !prev);
      }
    }
    // `true` = capture phase, so this fires before the global document-level bubble listener.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  function go(slug: string) {
    handleOpenChange(false);
    router.push(`/kb/${slug}`);
  }

  const hits: ArticleHit[] = data?.articles?.hits ?? [];
  const degraded = data?.degraded === true;
  const hasQuery = debounced.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("quickSwitcher.title")}</DialogTitle>
          <DialogDescription>{t("quickSwitcher.description")}</DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("quickSwitcher.placeholder")}
          />
          <CommandList aria-live="polite">
            {!hasQuery ? (
              <StatusRow>{t("quickSwitcher.startTyping")}</StatusRow>
            ) : isError || degraded ? (
              <StatusRow tone="error">{t("quickSwitcher.unavailable")}</StatusRow>
            ) : hits.length === 0 ? (
              isFetching ? (
                <StatusRow>{t("quickSwitcher.searching")}</StatusRow>
              ) : (
                <StatusRow>
                  {t("quickSwitcher.noResults", { query: debounced })}
                </StatusRow>
              )
            ) : (
              <CommandGroup heading={t("quickSwitcher.heading")}>
                {hits.map((hit) => (
                  <CommandItem
                    key={hit.id}
                    value={hit.id}
                    onSelect={() => go(hit.slug)}
                    className="gap-2"
                  >
                    <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{hit.title}</span>
                    {hit.excerpt ? (
                      <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                        {hit.excerpt}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** A muted (or destructive) full-width status row for the empty / loading / outage states. */
function StatusRow({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
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
