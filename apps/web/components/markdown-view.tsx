"use client";

import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/markdown-code-block";
import { MermaidDiagram } from "@/components/markdown-mermaid";
import {
  rehypeWikiLinks,
  WIKI_LINK_TAG,
} from "@/components/markdown-wiki-link";
import { WikiLink } from "@/components/markdown-wiki-link-view";
import {
  rehypeSecretChips,
  SECRET_CHIP_TAG,
} from "@/components/markdown-secret-chip";
import { SecretChip } from "@/components/markdown-secret-chip-view";
import { cn } from "@/lib/utils";

/**
 * Strict HTML sanitization allow-list for rendered Markdown. Derived from
 * `rehype-sanitize`'s `defaultSchema` (a conservative GitHub-flavoured base that
 * already drops `<script>`/`<style>`, event-handler attributes and dangerous URL
 * protocols such as `javascript:`), then narrowed/extended for our needs:
 *
 *  - GFM extras the base schema already covers (tables, task-list checkboxes,
 *    strikethrough) are kept.
 *
 * `target`/`rel` are deliberately NOT widened here (#512): the base schema's `a` allow-list stands.
 * Anchor safety is enforced at render time by the `SafeAnchor` renderer below, which forces
 * `rel="noopener noreferrer"` on any `target="_blank"` — so a future plugin that emits `target=_blank`
 * can never produce reverse-tabnabbing / referrer leakage, and the sanitizer stays as tight as the base.
 *
 * Sanitizing here closes SEC-003 (stored XSS via KB Markdown) **by construction**:
 * even if `rehype-raw` is ever enabled upstream, untrusted HTML is filtered
 * against this allow-list rather than rendered verbatim.
 */
const SANITIZE_SCHEMA = defaultSchema;

/**
 * Custom renderers (issue #200, #310). Fenced code blocks get syntax highlighting + a per-block
 * copy button via `CodeBlock`; a ` ```mermaid ` block renders as a sandboxed diagram via
 * `MermaidDiagram`; inline code stays a plain `<code>`. All of these are produced by React
 * components **after** `rehype-sanitize` runs, so the sanitizer never sees the token markup or
 * the mermaid SVG — `SANITIZE_SCHEMA` needs no widening and the SEC-003 guarantee above is
 * preserved by construction.
 */
const MARKDOWN_COMPONENTS: Components = {
  // A fenced block carries a `language-*` class (react-markdown 10 convention). Inline code
  // has no such class → render it untouched. The hast `node` is destructured out so it never
  // reaches the DOM <code>.
  code({ node, className, children, ...rest }) {
    void node;
    const match = /language-(\w+)/.exec(className ?? "");
    const language = match?.[1] ?? "";
    const text = String(children ?? "");
    // A `mermaid` fence renders as a diagram (strict, sandboxed, error-bounded — issue #310).
    // It runs after sanitize just like CodeBlock, so SANITIZE_SCHEMA stays untouched.
    if (language === "mermaid") {
      return <MermaidDiagram value={text.replace(/\n$/, "")} />;
    }
    // No language class AND single-line → inline code; keep it as a plain <code>.
    if (!match && !text.includes("\n")) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return <CodeBlock language={language} value={text.replace(/\n$/, "")} />;
  },
  // `CodeBlock` already renders its own surface; pass the wrapper through so a fenced block
  // isn't double-wrapped in the default <pre> (inline code never reaches this renderer).
  pre({ children }: ComponentPropsWithoutRef<"pre">) {
    return <>{children}</>;
  },
  // #512: force `rel="noopener noreferrer"` on any anchor that opens in a new tab. The sanitize
  // schema no longer allows `target`/`rel` at all (so today nothing reaches here with `target`), but
  // this makes the guarantee navigation-independent: should a remark/rehype plugin ever emit
  // `target="_blank"`, the opened tab can never reach `window.opener` and the referrer is stripped.
  a({ node, target, rel, ...rest }) {
    void node;
    const safeRel = target === "_blank" ? "noopener noreferrer" : rel;
    return <a target={target} rel={safeRel} {...rest} />;
  },
};

/**
 * The `[[slug]]` wiki-link element minted by `rehypeWikiLinks` AFTER sanitize (ADR-0059 §3) — added
 * to the components map separately because react-markdown's `Components` type only knows HTML tags.
 * It runs in the same post-sanitize slot as the mermaid/code renderers, so the schema stays untouched;
 * react-markdown passes the element's hast properties (`slug`, `label`) through as props at runtime.
 */
const WIKI_LINK_COMPONENTS = {
  [WIKI_LINK_TAG]: ({ slug, label }: { slug?: string; label?: string }) => (
    <WikiLink slug={slug} label={label} />
  ),
} as Components;

/**
 * The `{{ lazyit_secret.HANDLE }}` chip element minted by `rehypeSecretChips` AFTER sanitize
 * (ADR-0061 §8) — same post-sanitize slot as wiki-links and code renderers. The component handles
 * all three chip states (locked / broken / revealed) and drives the session unlock gate when
 * needed. `handle` is the only data carried; no value is ever embedded in the Markdown source.
 */
const SECRET_CHIP_COMPONENTS = {
  [SECRET_CHIP_TAG]: ({ handle }: { handle?: string }) => (
    <SecretChip handle={handle} />
  ),
} as Components;

const ALL_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  ...WIKI_LINK_COMPONENTS,
  ...SECRET_CHIP_COMPONENTS,
};

/**
 * Renders Markdown (GFM: tables, task lists, strikethrough, autolinks) as styled
 * HTML via the Tailwind typography `prose` classes. Any raw/embedded HTML is run
 * through `rehype-sanitize` with the strict allow-list above, so the output is
 * safe against stored XSS regardless of the Markdown source. Fenced code blocks are
 * syntax-highlighted with a per-block copy button (issue #200); the highlighter runs in
 * React after sanitize, so the schema stays untouched. Used by the KB detail view and the
 * editor preview (ADR-0021 — simple wiki, no heavy editor), and by the public Help/Manual
 * surface (ADR-0062) via `disableKbExtensions`.
 *
 * @param disableKbExtensions When `true`, the two KB-only render passes —
 *   `rehypeWikiLinks` (`[[slug]]` → `Article` lookup) and `rehypeSecretChips`
 *   (`{{ lazyit_secret.* }}` → masked chip) — are NOT applied, so those tokens render as
 *   literal text. Used by the public Help/Manual pages (ADR-0062 §2): they are secret-free
 *   and have no `Article` rows to resolve against, so the KB passes would be meaningless
 *   (and a chip there must never imply a vault binding). Defaults to `false`, so every
 *   existing KB call site behaves identically — this prop is purely additive.
 */
export function MarkdownView({
  content,
  className,
  disableKbExtensions = false,
}: {
  content: string;
  className?: string;
  disableKbExtensions?: boolean;
}) {
  // LOAD-BEARING plugin order (SEC-003 / ADR-0029 / ADR-0059 §3): `rehypeSanitize` MUST run FIRST —
  // it strips all untrusted HTML before any trusted post-sanitize pass adds markup the schema never
  // has to allow. The KB-only passes (`rehypeWikiLinks`, `rehypeSecretChips`) live in that
  // post-sanitize slot and are appended ONLY when KB extensions are enabled. For the Manual
  // (`disableKbExtensions`) the pipeline is sanitize-only, so `[[slug]]` and `{{ lazyit_secret.* }}`
  // survive untouched as plain text. NEVER reorder: sanitize stays first in both branches.
  // Typed via the component's own prop so the conditional's two array shapes both narrow to the
  // expected `PluggableList` (re-exported by react-markdown from `unified`) without a fragile
  // transitive import.
  const rehypePlugins: ComponentProps<typeof Markdown>["rehypePlugins"] =
    disableKbExtensions
      ? [[rehypeSanitize, SANITIZE_SCHEMA]]
      : [[rehypeSanitize, SANITIZE_SCHEMA], rehypeWikiLinks, rehypeSecretChips];

  // With the KB passes off, the wiki-link / secret-chip elements can never be minted, so the
  // components map is the plain HTML-only set — keeping the rendered tree free of any KB element.
  const components = disableKbExtensions ? MARKDOWN_COMPONENTS : ALL_COMPONENTS;

  return (
    <div
      className={cn(
        // ADR-0049: crisp reads — balanced headings, calm links, no garish pre default (CodeBlock
        // owns its own surface), and `text-pretty` to avoid orphans in body copy.
        "prose prose-sm max-w-none text-pretty dark:prose-invert",
        "prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-pretty",
        "prose-a:font-medium prose-a:text-primary prose-a:underline-offset-2",
        "prose-pre:bg-muted prose-pre:text-foreground",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
