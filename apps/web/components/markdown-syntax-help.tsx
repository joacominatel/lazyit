"use client";

import {
  ArrowTopRightOnSquareIcon,
  QuestionMarkCircleIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * MarkdownSyntaxHelp — the `?` cheat-sheet for the KB article editor (issue #720).
 *
 * Writing KB articles is otherwise "blind": Markdown plus lazyit's two reserved tokens
 * (`[[slug]]` wiki-links, `{{ lazyit_secret.HANDLE }}` secret chips) have no inline hint. This is a
 * quiet ghost `?` that sits in the editor toolbar (so it covers `/kb/new` AND the edit route via the
 * one `MarkdownEditor`), opening a short, scannable Popover of the reserved syntax with copyable
 * examples. The example tokens are the EXACT forms the renderer understands (`markdown-wiki-link.ts`
 * §`WIKI_LINK_TOKEN`, `markdown-secret-chip.ts` §`SECRET_CHIP_TOKEN`) — nothing aspirational.
 *
 * UX: a Popover (not a Sheet) because the content is a glanceable reference the writer wants beside
 * the editor without a heavy overlay; the live preview pane already shows how a token RESOLVES, so
 * this only has to teach the WRITE side. Visual register matches the workflow `TokenPicker`/
 * `TokenHighlight` house style (font-mono chips on a tinted surface).
 *
 * ponytail: deliberately a static cheat-sheet — no in-textarea token highlighting (that needs a
 * heavy editor dep; the existing split/preview pane covers "see how it resolves"). Upgrade path if
 * ever justified: a CodeMirror lang-markdown overlay, gated behind real demand (YAGNI today).
 */

/** Each block (a copyable token + its copy aria-label) shares the same chip + copy layout. */
function SyntaxExample({
  snippet,
  copyLabel,
}: {
  snippet: string;
  copyLabel: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary ring-1 ring-primary/20">
        {snippet}
      </code>
      <CopyButton value={snippet} label={copyLabel} className="shrink-0" />
    </div>
  );
}

/** A titled section: heading, one or more examples, and a one-line plain-language note. */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-xs font-semibold text-foreground">{title}</h4>
      <div className="space-y-1">{children}</div>
      <p className="text-xs leading-snug text-muted-foreground">{note}</p>
    </section>
  );
}

export function MarkdownSyntaxHelp() {
  const t = useTranslations("shared.editor.help");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("trigger")}
          title={t("trigger")}
          className="text-muted-foreground"
        >
          <QuestionMarkCircleIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(70vh,32rem)] w-80 space-y-3 overflow-y-auto"
      >
        <header className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">
            {t("title")}
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            {t("intro")}
          </p>
        </header>

        <Section title={t("wikiLink.title")} note={t("wikiLink.note")}>
          <SyntaxExample snippet="[[article-slug]]" copyLabel={t("copyLabel")} />
          <SyntaxExample
            snippet="[[article-slug|Display text]]"
            copyLabel={t("copyLabel")}
          />
        </Section>

        <Section title={t("secret.title")} note={t("secret.note")}>
          <SyntaxExample
            snippet="{{ lazyit_secret.handle }}"
            copyLabel={t("copyLabel")}
          />
        </Section>

        <Section title={t("links.title")} note={t("links.note")}>
          <SyntaxExample
            snippet="[Link text](https://example.com)"
            copyLabel={t("copyLabel")}
          />
        </Section>

        <Section title={t("markdown.title")} note={t("markdown.note")}>
          <SyntaxExample snippet="## Heading" copyLabel={t("copyLabel")} />
          <SyntaxExample
            snippet="**bold**  _italic_  `code`"
            copyLabel={t("copyLabel")}
          />
          <SyntaxExample
            snippet={"- list item\n- list item"}
            copyLabel={t("copyLabel")}
          />
        </Section>

        <Link
          href="/help/knowledge-base-articles-authoring"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {t("manualLink")}
          <ArrowTopRightOnSquareIcon className="size-3" aria-hidden />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
