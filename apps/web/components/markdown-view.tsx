"use client";

import type { ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/markdown-code-block";
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
 * Custom renderers (issue #200). Fenced code blocks get syntax highlighting + a per-block
 * copy button via `CodeBlock`; inline code stays a plain `<code>`. Highlighting is produced
 * by these React components **after** `rehype-sanitize` runs, so the sanitizer never sees the
 * token markup — `SANITIZE_SCHEMA` needs no widening and the SEC-003 guarantee above is
 * preserved by construction.
 */
const MARKDOWN_COMPONENTS: Components = {
  // A fenced block carries a `language-*` class (react-markdown 10 convention). Inline code
  // has no such class → render it untouched. The hast `node` is destructured out so it never
  // reaches the DOM <code>.
  code({ node, className, children, ...rest }) {
    void node;
    const match = /language-(\w+)/.exec(className ?? "");
    const text = String(children ?? "");
    // No language class AND single-line → inline code; keep it as a plain <code>.
    if (!match && !text.includes("\n")) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <CodeBlock language={match?.[1] ?? ""} value={text.replace(/\n$/, "")} />
    );
  },
  // `CodeBlock` already renders its own surface; pass the wrapper through so a fenced block
  // isn't double-wrapped in the default <pre> (inline code never reaches this renderer).
  pre({ children }: ComponentPropsWithoutRef<"pre">) {
    return <>{children}</>;
  },
};

/**
 * Renders Markdown (GFM: tables, task lists, strikethrough, autolinks) as styled
 * HTML via the Tailwind typography `prose` classes. Any raw/embedded HTML is run
 * through `rehype-sanitize` with the strict allow-list above, so the output is
 * safe against stored XSS regardless of the Markdown source. Fenced code blocks are
 * syntax-highlighted with a per-block copy button (issue #200); the highlighter runs in
 * React after sanitize, so the schema stays untouched. Used by the KB detail view and the
 * editor preview (ADR-0021 — simple wiki, no heavy editor).
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
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </Markdown>
    </div>
  );
}
