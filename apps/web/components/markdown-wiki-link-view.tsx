"use client";

import { PlusIcon } from "@heroicons/react/16/solid";
import Link from "next/link";
import { createContext, type ReactNode, useContext } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * The React side of the `[[slug]]` wiki-link (ADR-0059 §3). The `rehypeWikiLinks` pass
 * (`markdown-wiki-link.ts`) turns each token into a `wikilink` hast element AFTER sanitize;
 * `MarkdownView` maps that element to {@link WikiLink}. Resolution (does this slug point at a live
 * article?) is render-time state supplied by a {@link WikiLinkProvider} the page wraps the view in.
 *
 *  - **Resolved** → a clickable `next/link` to `/kb/:slug` (calm prose-link styling).
 *  - **Unresolved** → a NON-clickable `<span>` with a dotted underline + a tooltip ("document not
 *    created yet"), exactly per the ADR — a forward reference, never an error.
 *
 * When no provider is present (or it returns `undefined`) the link renders in a neutral "pending"
 * state — the same calm unresolved affordance — so the editor preview degrades gracefully.
 */

/** Resolve a `[[slug]]` to its target article (or `null` when no live article has that slug). */
export type WikiLinkResolver = (slug: string) => { slug: string } | null;

const WikiLinkContext = createContext<WikiLinkResolver | null>(null);

/** Provide the slug→article resolver to every `[[slug]]` rendered inside `children`. */
export function WikiLinkProvider({
  resolve,
  children,
}: {
  resolve: WikiLinkResolver;
  children: ReactNode;
}) {
  return (
    <WikiLinkContext.Provider value={resolve}>
      {children}
    </WikiLinkContext.Provider>
  );
}

/**
 * OPTIONAL hover-preview decorator for RESOLVED wiki-links (#1106 Phase 2). A render-prop so this
 * markdown-view module stays free of any Quick View / data-hook import: the KB reading page supplies a
 * function that wraps a resolved link in its hover popover ({@link QuickViewPopover}, entity `article`)
 * for the `slug`. When no provider is present (the editor preview, the Manual, any non-KB caller) a
 * resolved link renders plain — the preview is purely additive and degrades to nothing.
 */
export type WikiLinkPreviewRenderer = (
  slug: string,
  link: ReactNode,
) => ReactNode;

const WikiLinkPreviewContext = createContext<WikiLinkPreviewRenderer | null>(
  null,
);

/** Provide the resolved-link hover-preview decorator to every `[[slug]]` rendered inside `children`. */
export function WikiLinkPreviewProvider({
  render,
  children,
}: {
  render: WikiLinkPreviewRenderer;
  children: ReactNode;
}) {
  return (
    <WikiLinkPreviewContext.Provider value={render}>
      {children}
    </WikiLinkPreviewContext.Provider>
  );
}

/**
 * OPTIONAL create-on-click decorator for UNRESOLVED wiki-links (#1106 Phase 4). Builds the href a
 * red `[[slug]]` navigates to so the reader can author the missing note (`/kb/new` prefilled with the
 * slug + a title from the label). A render-prop for the same reason as the preview: this module stays
 * free of the KB route/permission wiring. The KB reading page supplies the builder ONLY for a caller
 * who holds `article:write`; when it is `null` (a reader, the editor preview, the Manual, any non-KB
 * caller) the unresolved link stays the calm inert "not created yet" tooltip.
 */
export type WikiLinkCreateHrefBuilder = (slug: string, label: string) => string;

const WikiLinkCreateContext = createContext<WikiLinkCreateHrefBuilder | null>(
  null,
);

/**
 * Provide (or withhold) the unresolved-link create affordance. Pass `build` to turn every unresolved
 * `[[slug]]` into a "create this note" link; pass `null` to keep the inert tooltip (readers, previews).
 */
export function WikiLinkCreateProvider({
  build,
  children,
}: {
  build: WikiLinkCreateHrefBuilder | null;
  children: ReactNode;
}) {
  return (
    <WikiLinkCreateContext.Provider value={build}>
      {children}
    </WikiLinkCreateContext.Provider>
  );
}

/**
 * Render one `[[slug]]` token. `slug` is the resolution key; `label` is the display text (the
 * `|display` alias or the verbatim target). Consults the context resolver: a hit is a clickable KB
 * link, a miss (or no resolver) is a non-clickable tooltip — the ADR-0059 §3 "document not created
 * yet" forward reference.
 */
export function WikiLink({
  slug,
  label,
}: {
  slug?: string;
  label?: string;
}) {
  const t = useTranslations("kb");
  const resolve = useContext(WikiLinkContext);
  const renderPreview = useContext(WikiLinkPreviewContext);
  const buildCreateHref = useContext(WikiLinkCreateContext);
  const text = label ?? slug ?? "";

  // No slug (shouldn't happen — the transform always sets one) → render the raw text.
  if (!slug) return <>{text}</>;

  const target = resolve?.(slug) ?? null;

  if (target) {
    const link = (
      <Link
        href={`/kb/${encodeURIComponent(target.slug)}`}
        className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        data-wikilink="resolved"
      >
        {text}
      </Link>
    );
    // KB-only hover preview (#1106 Phase 2): decorate the resolved link when a preview provider is
    // present; otherwise render it plain (editor preview / Manual / any non-KB caller).
    return renderPreview ? <>{renderPreview(slug, link)}</> : link;
  }

  // Unresolved WITH a create builder (#1106 Phase 4): a caller who may author (`article:write`) turns
  // the forward reference into a "create this note" link → /kb/new prefilled with the slug + a title
  // from the label. Keeps the calm dotted underline (still "not created"), adds a small plus so it
  // reads as an invitation to author, never an error. KB-only: the builder is supplied only there.
  if (buildCreateHref) {
    return (
      <Link
        href={buildCreateHref(slug, text)}
        className="font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:text-foreground hover:decoration-foreground/60"
        title={t("wikiLinks.createTooltip")}
        data-wikilink="create"
      >
        {text}
        <PlusIcon
          className="ml-0.5 inline size-3 align-[-0.1em] text-muted-foreground"
          aria-hidden
        />
      </Link>
    );
  }

  // Unresolved (or no resolver yet): a non-clickable forward reference with a calm dotted underline
  // and a native tooltip. Muted, never a destructive/error tone — it's an invitation, not a fault.
  return (
    <span
      className={cn(
        "cursor-help text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2",
      )}
      title={t("wikiLinks.unresolvedTooltip")}
      data-wikilink="unresolved"
    >
      {text}
    </span>
  );
}
