"use client";

import { CubeIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { ArticleLink } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";
import { useArticleLinks } from "@/lib/api/hooks/use-article-links";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useAsset } from "@/lib/api/hooks/use-assets";

/**
 * "Covers …" chip row under the article title (#1106 Phase 2) — a glanceable, READ-ONLY summary of
 * what this runbook is about: the assets (🖥) and applications (🔑) it is linked to (ADR-0042). Per the
 * CEO the row is HIDDEN entirely when the article covers nothing — no empty label, no placeholder. The
 * add/remove WRITE surface stays in the Connections rail's "Linked to" section; these chips only link
 * out to each record.
 *
 * Data is the article's own links (`useArticleLinks`, already fetched by the rail) — zero extra list
 * fetch; each asset chip resolves its own name by id (assets aren't loaded en masse, #199).
 */
export function ArticleCoversRow({ articleId }: { articleId: string }) {
  const t = useTranslations("kb");
  const { data: links } = useArticleLinks(articleId);
  const { data: applications } = useApplications();

  const appById = useMemo(
    () => new Map((applications ?? []).map((a) => [a.id, a.name])),
    [applications],
  );

  const rows = links ?? [];
  // CEO decision: no links → no row at all (never an empty "Covers" affordance).
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("covers.label")}
      </span>
      <ul className="flex flex-wrap items-center gap-1.5">
        {rows.map((link) => (
          <li key={link.id}>
            <CoverChip
              link={link}
              appName={
                link.applicationId
                  ? (appById.get(link.applicationId) ??
                    t("links.fallbackApplication"))
                  : undefined
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One "Covers" chip — an asset or application link, resolving its own name and deep-linking to the
 *  record. Mirrors the link-panel `LinkRow` name resolution so the two surfaces never drift. */
function CoverChip({
  link,
  appName,
}: {
  link: ArticleLink;
  /** Pre-resolved application name (when this is an application link). */
  appName?: string;
}) {
  const t = useTranslations("kb");
  const isAsset = Boolean(link.assetId);
  const { data: asset } = useAsset(link.assetId ?? undefined);

  const name = isAsset
    ? (asset?.name ?? t("links.fallbackAsset"))
    : (appName ?? t("links.fallbackApplication"));
  const href = isAsset
    ? `/assets/${link.assetId}`
    : `/applications/${link.applicationId}`;
  const Icon = isAsset ? CubeIcon : KeyIcon;

  return (
    <Link
      href={href}
      className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </Link>
  );
}
