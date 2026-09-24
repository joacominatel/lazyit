"use client";

import { ArrowTopRightOnSquareIcon, GlobeAltIcon } from "@heroicons/react/24/outline";
import type { AiMessagePart } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { webSourceLinks } from "@/lib/ai/web-sources";

type SourcesPart = Extract<AiMessagePart, { type: "sources" }>;

/**
 * The pages the provider's web search drew on, under the assistant's answer (#1389). Plain-text titles,
 * `http(s)` links only (re-checked here), opened in a new tab with `rel="noopener noreferrer"` so the
 * page gets neither a handle on lazyit nor the referrer. A note says they are web results — content
 * written by others, not lazyit records.
 */
export function AiWebSources({ part }: { part: SourcesPart }) {
  const t = useTranslations("ai.sources");
  const links = webSourceLinks(part.sources);
  if (links.length === 0) return null;
  return (
    <section
      aria-label={t("title")}
      className="space-y-1.5 rounded-md border bg-muted/20 px-3 py-2 text-sm"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <GlobeAltIcon className="size-4" aria-hidden />
        {t("title")}
      </p>
      <ol className="space-y-1">
        {links.map((link) => (
          <li key={link.href} className="min-w-0">
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1 font-medium underline-offset-4 hover:underline"
            >
              <span className="truncate">{link.label}</span>
              <ArrowTopRightOnSquareIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">{t("newTab")}</span>
            </a>
            <span className="ml-1.5 text-xs text-muted-foreground">{link.host}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">{t("note")}</p>
    </section>
  );
}
