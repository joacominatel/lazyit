"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Renders Markdown (GFM: tables, task lists, strikethrough, autolinks) as styled
 * HTML via the Tailwind typography `prose` classes. Raw HTML in the source is
 * escaped, not rendered — react-markdown does not enable `rehype-raw`, so this is
 * safe against stored XSS by default. Used by the KB detail view and the editor
 * preview (ADR-0021 — simple wiki, no heavy editor).
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
      <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
    </div>
  );
}
