"use client";

import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import diff from "react-syntax-highlighter/dist/esm/languages/hljs/diff";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import plaintext from "react-syntax-highlighter/dist/esm/languages/hljs/plaintext";
import powershell from "react-syntax-highlighter/dist/esm/languages/hljs/powershell";
import shell from "react-syntax-highlighter/dist/esm/languages/hljs/shell";
import sql from "react-syntax-highlighter/dist/esm/languages/hljs/sql";
import typescript from "react-syntax-highlighter/dist/esm/languages/hljs/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/hljs/yaml";
import { restraintCodeTheme } from "@/components/markdown-code-theme";

/**
 * The `react-syntax-highlighter` Light/hljs build plus a small, curated language set (issue
 * #200 — only the grammars KB authors actually use, to keep the editor route's bundle small).
 * The Light build requires explicit `registerLanguage` calls; we track the registered set in
 * `REGISTERED` because the v16 Light build does not expose `supportedLanguages` at runtime.
 *
 * Aliases let common fence labels resolve to a registered grammar. Anything unregistered
 * (incl. a fenced block with no language) falls back to `plaintext` — a readable plain
 * block, never a crash.
 */
const REGISTERED = new Set([
  "bash",
  "diff",
  "javascript",
  "json",
  "plaintext",
  "powershell",
  "shell",
  "sql",
  "typescript",
  "yaml",
]);

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("diff", diff);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("plaintext", plaintext);
SyntaxHighlighter.registerLanguage("powershell", powershell);
SyntaxHighlighter.registerLanguage("shell", shell);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("yaml", yaml);

/** Fence-label aliases → a registered grammar. */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "shell",
  zsh: "shell",
  console: "shell",
  shellsession: "shell",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  text: "plaintext",
  txt: "plaintext",
};

function resolveLanguage(language: string): string {
  const lower = language.toLowerCase();
  const aliased = LANGUAGE_ALIASES[lower] ?? lower;
  // Unregistered grammars (and the empty/no-language case) fall back to a readable plain
  // block — the Light build would otherwise warn and render unstyled.
  return REGISTERED.has(aliased) ? aliased : "plaintext";
}

/**
 * The actual highlighting render — a `<pre><code>` carrying the token markup. The owning
 * `CodeBlock` provides the `--muted` surface, header and copy affordance; here we keep the
 * `<pre>` transparent and inherit the surface's type so the block reads as one panel.
 * Highlighting is produced by React *after* `rehype-sanitize` has run, so the sanitizer
 * never sees these spans — SEC-003's stored-XSS guarantee is untouched.
 */
export default function CodeHighlighter({
  language,
  value,
}: {
  language: string;
  value: string;
}) {
  return (
    <SyntaxHighlighter
      language={resolveLanguage(language)}
      style={restraintCodeTheme}
      wrapLongLines
      customStyle={{
        margin: 0,
        padding: "1rem",
        background: "transparent",
        fontSize: "inherit",
        lineHeight: "inherit",
        overflowX: "auto",
      }}
      codeTagProps={{ style: { fontFamily: "inherit" } }}
    >
      {value}
    </SyntaxHighlighter>
  );
}
