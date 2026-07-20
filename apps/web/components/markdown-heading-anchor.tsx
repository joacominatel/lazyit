"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";

/**
 * HeadingAnchor — a section heading with a hover-revealed deep-link anchor (#1106 Phase 1).
 *
 * `rehype-slug` (post-sanitize) stamps a stable, deduped `id` on every heading; `MarkdownView` maps
 * `h2`/`h3` here. The heading renders its text plus a quiet trailing "#" link that appears on hover /
 * keyboard focus. Clicking it navigates to the in-page anchor (the browser updates the hash and
 * scrolls — `scroll-mt` keeps the target clear of any sticky chrome) AND copies the absolute deep
 * link to the clipboard, so a reader can share a link straight to the section.
 *
 * Colour stays disciplined (ADR-0049): the "#" is muted, underline-free, and only tints to the link
 * colour on hover — never garish small coloured text.
 */
export function HeadingAnchor({
  level,
  id,
  children,
}: {
  level: 2 | 3;
  id?: string;
  children?: ReactNode;
}) {
  const t = useTranslations("shared");
  const Tag = `h${level}` as const;

  // No id (rehype-slug produces one for every heading, but be defensive) → plain heading.
  if (!id) {
    return <Tag className="scroll-mt-24">{children}</Tag>;
  }

  const copyDeepLink = () => {
    // Let the default `#id` navigation run (hash + scroll); additionally copy the shareable link.
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success(t("anchor.copied")))
      .catch(() => {
        /* clipboard unavailable — the link still navigates, nothing to surface */
      });
  };

  return (
    <Tag id={id} className="group scroll-mt-24">
      {children}
      <a
        href={`#${id}`}
        onClick={copyDeepLink}
        aria-label={t("anchor.copyLink")}
        title={t("anchor.copyLink")}
        className="ml-2 font-normal text-muted-foreground no-underline opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
      >
        #
      </a>
    </Tag>
  );
}
