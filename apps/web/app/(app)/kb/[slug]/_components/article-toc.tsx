"use client";

import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * "On this page" table of contents for the KB reading view (#1106 Phase 2). Built from the ACTUAL
 * rendered heading ids (Phase 1 added `rehype-slug`), read straight from the prose DOM — so the TOC and
 * the deep-link anchors can never drift from a re-derived slug. A native `IntersectionObserver`
 * scroll-spy marks the section currently under the reading line (oxblood active marker); clicking a
 * row jumps to it via a plain `#id` anchor (the heading's `scroll-mt` clears any sticky chrome) and the
 * browser updates the URL hash.
 *
 * Two placements share one hook: a sticky rail list on `xl+` ({@link ArticleToc}) and a collapsed
 * `<details>` disclosure below `xl` ({@link ArticleTocDetails}). Both render nothing when the article
 * has no in-body headings — no empty "On this page" affordance.
 */

export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

/** The reading band for the scroll-spy: a heading is "active" once it crosses ~80px below the top and
 *  until it leaves the top third of the viewport (the `-66%` bottom margin). */
const SPY_ROOT_MARGIN = "-80px 0px -66% 0px";

/**
 * Collect the in-body `h2`/`h3` headings from the rendered prose `container` and track which one is
 * currently under the reading line. Re-collects when `contentKey` changes (a different article body).
 * DOM-driven, so the caller gates it behind a mounted flag to keep SSR and the first client render
 * identical.
 */
export function useTocHeadings(
  container: RefObject<HTMLElement | null>,
  contentKey: string,
): { headings: TocHeading[]; activeId: string | null } {
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>("h2[id], h3[id]"),
    );
    const collected: TocHeading[] = nodes.map((el) => ({
      id: el.id,
      // The heading text plus the trailing "#" deep-link anchor (HeadingAnchor) — strip the "#".
      text: (el.textContent ?? "").replace(/#\s*$/, "").trim(),
      level: el.tagName === "H3" ? 3 : 2,
    }));

    // Defer the state writes out of the effect body (past layout) — keeps the synchronous effect
    // setState-free (React Compiler `set-state-in-effect`) and lets late layout settle first.
    const raf = requestAnimationFrame(() => {
      setHeadings(collected);
      if (collected.length === 0) setActiveId(null);
    });

    if (nodes.length === 0) {
      return () => cancelAnimationFrame(raf);
    }

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // The first heading (document order) inside the reading band is the active one; when none is
        // in-band (scrolled past every heading) the last active marker simply persists.
        const firstVisible = collected.find((h) => visible.has(h.id));
        if (firstVisible) setActiveId(firstVisible.id);
      },
      { rootMargin: SPY_ROOT_MARGIN, threshold: 0 },
    );
    for (const el of nodes) observer.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [container, contentKey]);

  return { headings, activeId };
}

/** The shared heading list — one row per heading, the active one in the oxblood accent. */
function TocList({
  headings,
  activeId,
  onNavigate,
}: {
  headings: TocHeading[];
  activeId: string | null;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-0.5 text-sm">
      {headings.map((heading) => {
        const isActive = heading.id === activeId;
        return (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              aria-current={isActive ? "location" : undefined}
              onClick={onNavigate}
              className={cn(
                "block border-l-2 py-1 pr-2 transition-colors",
                heading.level === 3 ? "pl-5" : "pl-3",
                isActive
                  ? "border-primary font-medium text-primary"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {heading.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Sticky "On this page" rail list (xl+). Renders nothing when there are no headings. */
export function ArticleToc({
  headings,
  activeId,
  className,
}: {
  headings: TocHeading[];
  activeId: string | null;
  className?: string;
}) {
  const t = useTranslations("kb");
  if (headings.length === 0) return null;

  return (
    <nav aria-label={t("toc.label")} className={className}>
      <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("toc.label")}
      </p>
      <TocList headings={headings} activeId={activeId} />
    </nav>
  );
}

/** Collapsed "On this page ▾" disclosure (below xl). Renders nothing when there are no headings. */
export function ArticleTocDetails({
  headings,
  activeId,
  className,
}: {
  headings: TocHeading[];
  activeId: string | null;
  className?: string;
}) {
  const t = useTranslations("kb");
  if (headings.length === 0) return null;

  return (
    <details
      className={cn(
        "group rounded-lg border border-border bg-card/40 px-3 py-2",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase [&::-webkit-details-marker]:hidden">
        {t("toc.label")}
        <span
          aria-hidden
          className="text-muted-foreground/60 transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="mt-2">
        <TocList headings={headings} activeId={activeId} />
      </div>
    </details>
  );
}
