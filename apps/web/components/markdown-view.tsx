"use client";

import Markdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Strict HTML sanitization allow-list for rendered Markdown. Derived from
 * `rehype-sanitize`'s `defaultSchema` (a conservative GitHub-flavoured base that
 * already drops `<script>`/`<style>`, event-handler attributes and dangerous URL
 * protocols such as `javascript:`), then narrowed/extended for our needs:
 *
 *  - GFM extras the base schema already covers (tables, task-list checkboxes,
 *    strikethrough) are kept.
 *  - `target`/`rel` are allowed on links so rendered anchors can open safely.
 *
 * Sanitizing here closes SEC-003 (stored XSS via KB Markdown) **by construction**:
 * even if `rehype-raw` is ever enabled upstream, untrusted HTML is filtered
 * against this allow-list rather than rendered verbatim.
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
  },
};

/**
 * Renders Markdown (GFM: tables, task lists, strikethrough, autolinks) as styled
 * HTML via the Tailwind typography `prose` classes. Any raw/embedded HTML is run
 * through `rehype-sanitize` with the strict allow-list above, so the output is
 * safe against stored XSS regardless of the Markdown source. Used by the KB detail
 * view and the editor preview (ADR-0021 — simple wiki, no heavy editor).
 */
export function MarkdownView({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
      >
        {content}
      </Markdown>
    </div>
  );
}
