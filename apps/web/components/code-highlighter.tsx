"use client";

import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import diff from "react-syntax-highlighter/dist/esm/languages/hljs/diff";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/hljs/dockerfile";
import go from "react-syntax-highlighter/dist/esm/languages/hljs/go";
import ini from "react-syntax-highlighter/dist/esm/languages/hljs/ini";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import nginx from "react-syntax-highlighter/dist/esm/languages/hljs/nginx";
import plaintext from "react-syntax-highlighter/dist/esm/languages/hljs/plaintext";
import powershell from "react-syntax-highlighter/dist/esm/languages/hljs/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/hljs/python";
import shell from "react-syntax-highlighter/dist/esm/languages/hljs/shell";
import sql from "react-syntax-highlighter/dist/esm/languages/hljs/sql";
import typescript from "react-syntax-highlighter/dist/esm/languages/hljs/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/hljs/yaml";
import { restraintCodeTheme } from "@/components/markdown-code-theme";

/**
 * The `react-syntax-highlighter` Light/hljs build plus a curated IT-focused language set (issue
 * #200, extended in #1106 Phase 1 for the languages IT/Systems runbooks actually use: shells,
 * config (yaml/json/ini/toml/nginx), IaC (dockerfile/hcl), and the common scripting/app langs —
 * python/go/sql/js/ts). The Light build requires explicit `registerLanguage` calls; we track the
 * registered set in `REGISTERED` because the v16 Light build does not expose `supportedLanguages`
 * at runtime.
 *
 * Aliases let common fence labels resolve to a registered grammar. Anything unregistered
 * (incl. a fenced block with no language) falls back to `plaintext` — a readable plain
 * block, never a crash.
 */
const REGISTERED = new Set([
  "bash",
  "diff",
  "dockerfile",
  "go",
  "ini",
  "javascript",
  "json",
  "nginx",
  "plaintext",
  "powershell",
  "python",
  "shell",
  "sql",
  "typescript",
  "yaml",
]);

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("diff", diff);
SyntaxHighlighter.registerLanguage("dockerfile", dockerfile);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("ini", ini);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("nginx", nginx);
SyntaxHighlighter.registerLanguage("plaintext", plaintext);
SyntaxHighlighter.registerLanguage("powershell", powershell);
SyntaxHighlighter.registerLanguage("python", python);
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
  py: "python",
  golang: "go",
  docker: "dockerfile",
  containerfile: "dockerfile",
  // `ini` also renders TOML / conf-style key=value files acceptably.
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  // ponytail: the hljs Light build ships no HCL/Terraform grammar and adding one would be a second
  // net-new dep this phase forbids — `ini` is the closest registered approximation (key = value,
  // `#` comments) and keeps `hcl`/`tf`/`terraform` fences from degrading to unstyled plaintext.
  hcl: "ini",
  tf: "ini",
  terraform: "ini",
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
