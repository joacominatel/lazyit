---
title: "ADR-0029: Untrusted-content sanitization is render-time, not write-time"
tags: [adr, security]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0029: Untrusted-content sanitization is render-time, not write-time

## Status

accepted — 2026-05-25. Resolves the policy question raised by the security review
([[SEC-003-markdown-sanitizer-bypass-asymmetric|SEC-003]], [[SEC-008-application-url-href-xss-sink|SEC-008]])
and the deferred jsonb risk (DEF-004). Builds on [[0021-knowledge-base-design]],
[[0023-access-management-design]] and [[0007-flexible-asset-specs-jsonb]].

## Context

lazyit stores user-authored free text that a web client will later render as HTML or use in a link:

- KB **article `content`** (markdown) — [[0021-knowledge-base-design]].
- **`Application.url`** rendered as a link `href` — [[0023-access-management-design]].
- Unvalidated **`metadata` / `specs`** jsonb — [[0007-flexible-asset-specs-jsonb]] (DEF-004).

The review found these stored unsanitized; each becomes stored XSS the moment a web renderer outputs
it without contextual sanitization (SEC-003, SEC-008). An earlier ad-hoc defense — a regex strip on
the **import** path only — was bypassable and asymmetric (create/update never ran it), giving false
confidence. We need **one** policy so every untrusted-string-to-web-sink is covered by default.

## Considered options

1. **Sanitize on write** (mutate the stored value). One server choke point, but **lossy** and
   irreversible, and the server is the wrong place: HTML sanitization is contextual to the render
   target, and regex/HTML sanitization server-side is the known-bypassable anti-pattern SEC-003 hit.
2. **Sanitize on render** (allow-list at the web output): a real HTML sanitizer (DOMPurify /
   rehype-sanitize) over rendered markdown, and a scheme allow-list for any URL used as an `href`.
   Storage stays faithful; sanitization happens where the dangerous context is known. *(chosen)*
3. **Both** — render-time as authoritative plus light write-time defense in depth for clearly-unsafe
   structured values.

## Decision

- **Store raw on the write side; never mutate user content server-side.** The bypassable import-only
  regex strip is **removed** (SEC-003) — imported content is now stored verbatim, consistent with
  `POST`/`PATCH /articles`.
- **The authoritative defense is render-time on the web app** (option 2 + the structured-value
  guard, i.e. option 3 in practice): markdown is sanitized with an allow-list sanitizer over the
  rendered HTML; any value used as an `href` must have its scheme allow-listed.
- **Write-time validation rejects only clearly-dangerous *structured* values** that have no
  legitimate use — concretely `Application.url` rejects non-`http(s)` schemes (SEC-008), via
  `isSafeApplicationUrl` in `@lazyit/shared`, which the render layer reuses. This is defense in
  depth, not the authoritative layer.
- **Unvalidated jsonb** (`metadata`/`specs`, DEF-004) follows the same rule: stored as-is, treated as
  untrusted at every render sink.

## Consequences

- **Positive:** lossless storage; one discoverable policy; XSS defense lives where the render context
  is known; shared predicates (`isSafeApplicationUrl`) are reused web↔api; no security theater.
- **Deferred:** the render-time sanitizer lands **with the web KB renderer**, which does not exist yet
  — today article content is shown as escaped text (no raw-HTML/markdown renderer), so SEC-003/SEC-008
  are **latent, not live**. **Do not introduce a raw-HTML or markdown renderer without the allow-list
  sanitizer in the same change.** SEC-003 stays open until that render-time work lands.
- **Trade-off:** removing the import strip means imported markup is stored verbatim (matching
  create/update) — acceptable because nothing renders it unsanitized today and render-time is the
  real boundary.

## References

- [[SEC-003-markdown-sanitizer-bypass-asymmetric|SEC-003]] · [[SEC-008-application-url-href-xss-sink|SEC-008]] · DEF-004.
- [[0021-knowledge-base-design]] · [[0023-access-management-design]] · [[0007-flexible-asset-specs-jsonb]].
- OWASP XSS Prevention Cheat Sheet · DOMPurify / rehype-sanitize.
