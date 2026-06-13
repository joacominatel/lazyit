"use client";

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
  const text = label ?? slug ?? "";

  // No slug (shouldn't happen — the transform always sets one) → render the raw text.
  if (!slug) return <>{text}</>;

  const target = resolve?.(slug) ?? null;

  if (target) {
    return (
      <Link
        href={`/kb/${encodeURIComponent(target.slug)}`}
        className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        data-wikilink="resolved"
      >
        {text}
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
