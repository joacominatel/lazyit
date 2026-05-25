---
id: SEC-003
title: Markdown sanitizer is regex-based/bypassable and applied only on import, not on create/update
severity: low
status: open
cwe: CWE-79
discovered: 2026-05-25
module: articles
tags: [xss, stored-xss, sanitization, latent]
---

# SEC-003 — Bypassable, asymmetric markdown sanitization (latent stored XSS)

## Summary

`sanitizeMarkdown` is a best-effort regex strip that is trivially bypassable and runs **only** on the
import path; `POST /articles` and `PATCH /articles/:id` store `content` with no sanitization. The
authoritative defense (render-time sanitization) is deferred to a frontend that does not exist yet, so
KB content is stored as an XSS payload waiting for a renderer.

## Description

`article-import.ts:53` strips `<script>/<style>`, `on*=` handlers and the literal `javascript:` via
regex. Regex HTML sanitization is a known anti-pattern and bypassable, e.g.:

- `<img src=x onerror=alert(1)>` / `<svg onload=…>` — the `\son\w+=` strip misses attribute forms and
  obfuscations it doesn't anticipate.
- `javascript:` — defeated by `java&#9;script:`, entity encoding, or schemes that aren't stripped at
  all (`data:text/html`, `vbscript:`).
- Markdown permits raw HTML (`<iframe>`) and autolinks the strip doesn't cover.

The unit test (`article-import.spec.ts:36`) only asserts the happy path (`<script>`, `onclick=`,
`[x](javascript:…)`), giving false confidence. Worse, the sanitizer is reachable **only** through
`parseImportFile` (`article-import.ts:73,83`). The primary write paths store `content` verbatim:

```ts
this.prisma.article.create({ data: { content: data.content, ... } });  // articles.service.ts:104
this.prisma.article.update({ where: { id }, data: { ...rest, ... } }); // articles.service.ts:127 (rest includes content)
```

The code comment is explicit that render-time sanitization is "the authoritative defense" and is
deferred. There is no renderer yet, so nothing executes — the risk is **latent**, not live.

## Impact

Stored XSS the moment any client renders article markdown as HTML without sanitizing (the planned web
KB). A PUBLISHED article is team-visible, so one author's payload would run in every reader's session →
session/identity theft once auth exists. Latent today (no renderer) → **escalates to High** when the
frontend renders KB content.

## Proof of concept

Reasoned, **not executed**. `POST /articles` with
`content: "<img src=x onerror=alert(document.cookie)>"` stores it unchanged; a naive
`dangerouslySetInnerHTML` / `marked` render executes it. The import path is also bypassable with an
entity-encoded `javascript:` link.

## Affected

- `apps/api/src/articles/article-import.ts:53-59` — regex sanitizer (bypassable).
- `apps/api/src/articles/article-import.ts:73,83` — its only call sites.
- `apps/api/src/articles/articles.service.ts:104-118` (create), `:122-137` (update) — no sanitization.

## Recommendation

- Do not treat the regex strip as a security boundary; either remove it (to avoid false confidence) or
  keep it clearly labeled defense-in-depth only.
- Sanitize at **render time** with a real allow-list sanitizer (DOMPurify over rendered HTML), or
  sanitize server-side with a markdown-aware HTML sanitizer applied **uniformly to create/update AND
  import** — not just import.
- Track for the Phase-3 frontend review; the dangerous sink is on the web side.

## Prevention

One sanitization choke point for KB content, exercised by tests with real bypass vectors (entity
encoding, `data:`/`vbscript:`, `<svg onload>`, broken tags) — not just the happy path. Record the
decision (sanitize-on-write vs sanitize-on-render) as an ADR.

## References

- CWE-79: Improper Neutralization of Input During Web Page Generation (XSS). CWE-80.
- OWASP XSS Prevention Cheat Sheet · DOMPurify · ADR-0021 (KB design).

## Triage note

🚨 Escalated to user on 2026-05-25 — needs an ADR (sanitize-on-write vs sanitize-on-render) and a
sanitizer dependency; the dangerous sink is on the frontend (Phase 3). Choosing *where* to sanitize
is a product/architecture decision and either way pulls in a dep (DOMPurify / sanitize-html /
rehype-sanitize). The current regex strip is bypassable and asymmetric (import path only).

Options:

1. **Sanitize-on-render** (DOMPurify over rendered HTML) on the web app — OWASP-recommended,
   authoritative; defer to the Phase-3 frontend, and meanwhile **remove/relabel** the regex strip so
   it gives no false confidence (a cheap, in-lane change I can do now).
2. **Sanitize-on-write** server-side with a markdown-aware HTML sanitizer applied uniformly to
   create/update **and** import — one server choke point, but lossy (mutates stored content) + a new
   api dep.
3. **Both** — sanitize on write as defense-in-depth plus the authoritative render-time allow-list.

Recommendation: (1) — render-time is the authoritative layer and fits the deferred-frontend reality;
pair it with removing/relabeling the misleading regex strip now. Record the choice as an ADR. This +
SEC-008's render note are one "untrusted-string → web sink" policy for the frontend phase.
