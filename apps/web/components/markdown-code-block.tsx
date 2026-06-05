"use client";

import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/copy-button";
import CodeHighlighter from "@/components/code-highlighter";

/**
 * CodeBlock — the block-level fenced-code surface for `MarkdownView` (issue #200, ADR-0049).
 *
 * A `--muted` "paper" panel matching the old `prose-pre:bg-muted` look, with a quiet header
 * carrying the language label (in `--muted-foreground`, never coloured) and a reused
 * `CopyButton` (top-right). The body is the syntax highlighter; an unknown or empty language
 * falls back to a readable plain block (handled inside `CodeHighlighter`), never a crash.
 * Copy value is the exact raw source with the trailing newline already trimmed.
 *
 * The highlighter is the `react-syntax-highlighter` Light build with only ~10 registered
 * grammars, so it stays small enough to render synchronously (SSR-safe, no hydration guard,
 * no flash) rather than behind `next/dynamic`. Highlighting happens in React, *after*
 * `rehype-sanitize` — the sanitizer never sees the token spans, so `SANITIZE_SCHEMA` stays
 * untouched and SEC-003 is preserved.
 */
export function CodeBlock({
  value,
  language,
}: {
  /** Raw block source, trailing newline already trimmed. */
  value: string;
  /** The fence language label, or "" when none was declared. */
  language: string;
}) {
  const t = useTranslations("shared");
  const label = language || t("code.plainText");

  return (
    <div className="not-prose group relative my-4 overflow-hidden rounded-md border bg-muted">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-xs lowercase text-muted-foreground">
          {label}
        </span>
        <CopyButton
          value={value}
          label={t("code.copyCode")}
          toastMessage={t("code.copied")}
        />
      </div>
      <div className="text-sm leading-relaxed text-foreground">
        <CodeHighlighter language={language} value={value} />
      </div>
    </div>
  );
}
