/**
 * Render-time language auto-detection for fenced code blocks that declare NO language (KB/Settings
 * UX batch). Runs entirely client-side when a ` ``` ` fence carries no info-string, so it works on
 * EXISTING article bodies retroactively — nothing is stored or mutated.
 *
 * Returns one of the grammars ALREADY registered by `components/code-highlighter.tsx` (bash, diff,
 * dockerfile, go, ini, javascript, json, nginx, powershell, python, shell, sql, typescript, yaml)
 * when a signature is confident, else `null` — the caller then renders today's plain block. It never
 * mis-highlights aggressively: an uncertain block stays plaintext. An EXPLICIT fence language always
 * wins upstream (this only runs when none was declared).
 *
 * ponytail: no new dependency — deliberately NOT highlight.js/lowlight auto-detection. A short,
 * ordered list of regex signatures over the source (most-specific → least, so a strong marker wins
 * before a weak one) is enough for the IT/Systems runbook languages this KB actually holds, and stays
 * a pure, unit-tested function with zero bundle cost.
 */

/** A registered highlighter grammar name, or `null` when detection isn't confident. */
export type DetectedLanguage =
  | "bash"
  | "diff"
  | "dockerfile"
  | "go"
  | "ini"
  | "javascript"
  | "json"
  | "nginx"
  | "powershell"
  | "python"
  | "shell"
  | "sql"
  | "typescript"
  | "yaml"
  | null;

/**
 * Best-effort detect the language of an un-fenced-language code block. Pure and framework-agnostic;
 * see the module docstring for the confidence contract. Order is load-bearing — the first matching
 * signature wins, so unmistakable shapes (diff, Dockerfile, a strict-parseable JSON document) are
 * tested before the fuzzier keyword heuristics.
 */
export function detectCodeLanguage(code: string): DetectedLanguage {
  const source = code ?? "";
  const trimmed = source.trim();
  // Nothing to go on — never guess on an empty/whitespace block.
  if (trimmed.length === 0) return null;

  // 1. Unified diff / patch — the most unmistakable shape (git headers or hunk markers).
  if (
    /^diff --git /m.test(source) ||
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(source) ||
    (/^--- /m.test(source) && /^\+\+\+ /m.test(source))
  ) {
    return "diff";
  }

  // 2. Dockerfile — a `FROM <image>` plus at least one other instruction at line start (a lone
  //    `FROM` would also match SQL, so require a second Docker instruction for confidence).
  if (
    /^\s*FROM\s+\S+/im.test(source) &&
    /^\s*(RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|ENV|EXPOSE|LABEL|ARG|USER|VOLUME)\b/im.test(source)
  ) {
    return "dockerfile";
  }

  // 3. Shebang — a script interpreter line pins the shell family exactly. `.*` (not `\S*`) so a
  //    `#!/usr/bin/env bash` form — interpreter after a space — still resolves the family.
  const shebang = /^#!.*\b(bash|zsh|sh)\b/.exec(source);
  if (shebang) return shebang[1] === "sh" ? "shell" : "bash";

  // 4. JSON — a strict parse of a `{`/`[`-led document. JSON demands quoted keys, so a JS object
  //    literal (`{ a: 1 }`) or a YAML mapping fails this and falls through — a clean discriminator.
  if (/^[{[]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON — keep going.
    }
  }

  // 5. Shell session — a `$ ` prompt or a common admin/package command at line start.
  if (
    /^\s*\$ \S/m.test(source) ||
    /^\s*(sudo|apt|apt-get|yum|dnf|brew|systemctl|service|docker|kubectl|curl|wget)\s/m.test(source)
  ) {
    return "bash";
  }

  // 6. nginx — directive blocks (`server { … }`, `location … { … }`) or signature directives.
  if (
    /^\s*(server|location|upstream|http|events)\b[^\n;{]*\{/m.test(source) ||
    /^\s*(listen|server_name|proxy_pass|fastcgi_pass|worker_processes)\b/m.test(source)
  ) {
    return "nginx";
  }

  // 7. SQL — a statement verb paired with its companion clause (case-insensitive; SQL keyword casing
  //    varies wildly in the wild).
  if (
    /\bselect\b[\s\S]*\bfrom\b/i.test(source) ||
    /\binsert\s+into\b/i.test(source) ||
    /\bupdate\b[\s\S]*\bset\b/i.test(source) ||
    /\bdelete\s+from\b/i.test(source) ||
    /\bcreate\s+(table|database|index|view)\b/i.test(source)
  ) {
    return "sql";
  }

  // 8. Python — a def/class header, an import, or the classic `def name(...):` (the CEO's example).
  if (
    /^\s*def\s+\w+\s*\([^)]*\)\s*:/m.test(source) ||
    /^\s*class\s+\w+\s*[(:]/m.test(source) ||
    /^\s*(from\s+[\w.]+\s+import\s+|import\s+[\w.]+)/m.test(source)
  ) {
    return "python";
  }

  // 9. Go — a `package` clause, or `func` alongside a short-variable declaration / fmt call.
  if (
    /^\s*package\s+\w+/m.test(source) ||
    (/^\s*func\s+/m.test(source) && (/:=/.test(source) || /\bfmt\./.test(source)))
  ) {
    return "go";
  }

  // 10. PowerShell — the `Verb-Noun` cmdlet convention, `Write-Host`, or a `param(...)` block.
  if (
    /\b(Get|Set|New|Remove|Write|Import|Export|Invoke|Start|Stop|Add|Test)-[A-Z]\w+/.test(source) ||
    /^\s*param\s*\(/im.test(source) ||
    /\[CmdletBinding\(/.test(source)
  ) {
    return "powershell";
  }

  // 11. TypeScript — strong TS-only markers (checked before JS so a typed file isn't misread as JS).
  if (
    /^\s*(export\s+)?(interface|type)\s+\w+\s*[<={]/m.test(source) ||
    /^\s*(export\s+)?enum\s+\w+/m.test(source) ||
    /\bimport\s+type\b/.test(source) ||
    /\bas\s+const\b/.test(source) ||
    /\b(public|private|readonly)\s+\w+\s*:/.test(source)
  ) {
    return "typescript";
  }

  // 12. JavaScript — declarations, arrow functions, module glue, or ES import/export.
  if (
    /^\s*(export\s+)?(async\s+)?function\s*\*?\s*\w*\s*\(/m.test(source) ||
    /^\s*(const|let|var)\s+[\w{[]/m.test(source) ||
    /=>\s*[{(]/.test(source) ||
    /\b(require\(|module\.exports|console\.(log|error|warn))\b/.test(source) ||
    /^\s*import\s+[\w*{][^\n]*\bfrom\b/m.test(source) ||
    /^\s*export\s+(default|const|function|class)\b/m.test(source)
  ) {
    return "javascript";
  }

  // 13. YAML — a document marker, or several `key:` mappings (a single one is too weak to claim).
  const yamlKeyLines = (source.match(/^[ \t]*[\w.-]+:(?:\s|$)/gm) ?? []).length;
  if (
    /^---\s*$/m.test(source) ||
    yamlKeyLines >= 2 ||
    (yamlKeyLines >= 1 && /^\s*-\s+\w/m.test(source))
  ) {
    return "yaml";
  }

  // 14. INI / TOML — a `[section]` header alongside `key = value` pairs.
  if (/^\s*\[[^\]\n]+\]\s*$/m.test(source) && /^\s*[\w.-]+\s*=/m.test(source)) {
    return "ini";
  }

  // Not confident — the caller keeps today's plain block rather than risk a wrong grammar.
  return null;
}
