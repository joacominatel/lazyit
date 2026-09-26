---
title: Web Content-Security-Policy
tags: [security, web, csp, headers, defence-in-depth]
status: accepted
created: 2026-09-26
updated: 2026-09-26
---

# Web Content-Security-Policy

The web app's CSP (#1440) is **defence in depth**. The primary controls against injected content are
the Markdown sanitizer ([[0029-untrusted-content-sanitization]] — no raw HTML, every `<img>` deleted before the
sanitizer) and the Mermaid hardening of [[SEC-084-mermaid-html-labels-remote-image-load|SEC-084]]
(no HTML labels). SEC-084 was the reminder that a single render path emitting author HTML is enough
to load a remote image — a tracking pixel that leaks each reader's IP — and nothing behind it said no.
The CSP is that "no": if a future bug lets author- or model-controlled HTML reach the DOM, the browser
still refuses to run its script, load its remote images, or send data to another origin.

Code: `apps/web/lib/security/csp.ts` (the policy), `apps/web/proxy.ts` (per-request delivery),
`apps/web/app/layout.tsx` + `app/providers.tsx` (the nonce for next-themes),
`apps/web/instrumentation-client.ts` (zod jitless), `apps/web/next.config.ts` (the static baseline).
The policy is pinned by `lib/security/csp.test.ts`; the baseline by `next-config.test.ts`.

## Status: report-only

The policy ships as **`Content-Security-Policy-Report-Only`**: browsers evaluate it on every page and
log what they *would* block (`[Report Only]` console messages), but block nothing. Framing is
**enforced** regardless — see [Two headers](#two-headers).

Why not enforce on day one: every page family below was driven in Chromium against a production build
with the policy **enforced**, with zero violations — but two families could not be exercised end to
end in that pass, and a wrong CSP breaks a page silently:

- **AI chat streaming with approval cards** — needs a reachable model provider; the local pass had
  none, so the SSE stream and the approval card were not rendered under the policy.
- **The OAuth consent page with a real client** — only its error state (unknown `client_id`) was
  rendered; the grant → redirect-to-client path was not.

Both only use mechanisms the verified pages already exercise (`fetch` to the API origin, same-origin
scripts, inline styles; the consent redirect is a `window.location.assign`, which `form-action` does
not govern), so no violation is expected. Report-only turns that expectation into evidence before
anything can break.

### Verified (production build, policy enforced, Chromium, 2026-09-26)

Zero CSP violations on: `/` (landing, demo video), `/login`, `/setup`, `/forgot-password`, `/help` and
Manual pages, `/dashboard`, assets (list, detail **with an attachment**, edit, new, label, scan,
topology diagram / xyflow, servers table), KB (list, **article with two Mermaid diagrams, a
`blob:` attachment image and a remote image that must be dropped**, editor, new), applications (list,
detail, new, workflows, **workflow editor / CodeMirror**), access requests, consumables, locations,
users, imports, reports (charts), audit log, **Secret Manager bootstrap (Argon2id in a Web Worker via
WebAssembly)**, profile, account (including `/account/ai`), notifications, change password, and every
settings page including `/settings/ai`. The next-themes class was applied before paint.

### Enforcing

1. Exercise the two families above on a real instance with the report-only policy and confirm the
   browser console shows no `[Report Only]` CSP message.
2. Set `CSP_ENFORCED = true` in `apps/web/lib/security/csp.ts` and update the delivery-mode test. That
   switches the header name and adds `frame-ancestors 'none'` to the policy.
3. Update the Manual's *Reverse proxy & TLS* page ("report-only" → enforced) and this note.

## The policy

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Anything not listed below comes from lazyit only. |
| `script-src` | `'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'` | A fresh nonce per request; chunks loaded by a trusted script are trusted (`'strict-dynamic'`). `'wasm-unsafe-eval'` lets the Secret Manager's Argon2id (hash-wasm) compile WebAssembly — it does **not** allow JS `eval`. **No `'unsafe-inline'`.** Dev only: `'unsafe-eval'` (React's dev tooling). |
| `style-src` | `'self' 'unsafe-inline'` | **The documented concession** — see below. |
| `img-src` | `'self' data: blob:` | Attachments and pasted images are fetched with the Bearer token and shown as `blob:` URLs; icons and Mermaid use `data:`. **No remote host.** |
| `font-src` | `'self'` | Fonts are self-hosted by `next/font` (Hanken Grotesk is downloaded at build time; Commit Mono and Redaction are local woff2). |
| `media-src` | `'self'` | The landing demo video (`/landing/demo.mp4`). |
| `connect-src` | `'self'` (+ the API origin when `NEXT_PUBLIC_API_URL` is absolute) | The browser calls the API at the same-origin `/api` behind Caddy ([[0026-reverse-proxy-tls]]); local dev calls `http://localhost:3001`. SSE runs over `fetch`, so it is covered too. |
| `worker-src` | `'self' blob:` | The Argon2id worker. |
| `manifest-src` | `'self'` | |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | An injected `<base>` cannot re-point relative URLs. |
| `form-action` | `'self'` | Forms submit to lazyit only. |
| `frame-src` | `'none'` | lazyit embeds nothing. |
| `frame-ancestors` | `'none'` | Only in the enforcing policy (report-only cannot carry it); enforced today by the baseline header. |

Not set, deliberately: **`upgrade-insecure-requests`** — `lan` mode ([[0087-plain-http-lan-deployment-axis]])
serves plain HTTP, and upgrading its sub-resources to HTTPS would break it. No `report-uri` /
`report-to` yet: there is no collection endpoint, and the console is the report while the policy is
report-only.

### The `style-src 'unsafe-inline'` concession

Mermaid's rendered SVG carries its own `<style>` element; CodeMirror, sonner and xyflow inject
`<style>` tags at runtime; and server-rendered `style="…"` attributes (Radix, charts, progress bars)
cannot carry a nonce at all. Putting a nonce in `style-src` would also make browsers **ignore**
`'unsafe-inline'`, breaking all of those — so style-src has no nonce. CSS cannot execute script; the
residual risk is CSS-based UI redress or attribute-selector exfiltration, which the sanitizer (no
`style` attribute, no `<style>` element in rendered Markdown) already closes at the source.

## How it is delivered

- **Per request, by `proxy.ts`.** A nonce needs a request, so the policy cannot be a static header
  (the current Next.js CSP guide). The proxy mints 16 random bytes, builds the policy, and sets it on
  the **forwarded request** (Next reads the nonce back out of it while rendering and stamps it on its
  framework scripts, page bundles and inline RSC payload scripts; `x-nonce` hands it to the root
  layout) and on the **response**. The proxy's matcher now includes `/setup` so the first-run wizard
  gets a nonce too; it still skips `_next/static`, `_next/image`, `favicon.ico` and `/api/auth`.
- **Every page is dynamically rendered** already (the root layout reads the session and the locale
  cookie), so a nonce costs no static optimization. A future statically rendered page would render
  without a nonce and its scripts would be blocked once the policy enforces — the build output's
  `○ (Static)` marker is the thing to watch.
- **next-themes** renders an inline script that sets the theme class before paint; the root layout
  passes it the nonce (`ThemeProvider nonce`).
- **zod** probes `new Function("")` on its first object parse to decide whether it may JIT-compile
  validators. It catches the refusal and falls back, but the refusal is still a violation on every
  form. `instrumentation-client.ts` (which Next runs before any app code) sets zod's
  `jitless` config through the global zod keeps it in, so the probe never runs.

### Two headers

`next.config.ts` keeps sending the **enforced** `Content-Security-Policy: frame-ancestors 'none'` on
every response (static files, `/_next` assets and `/api/auth` included — the proxy does not see
those). While the content policy is report-only it travels in its own header, so pages carry both.
Once it enforces, the proxy's `Content-Security-Policy` (which then repeats `frame-ancestors 'none'`)
**replaces** the static value on pages: one header, never two.

## Operators

- The bundled Caddy sets **no** CSP; the app owns it. See [[deploy-self-hosted]] §8.
- A reverse proxy in front of lazyit must **not add a second enforcing `Content-Security-Policy`**:
  browsers enforce every policy they receive, and a static one cannot know the per-request nonce, so
  it would block every page's scripts.
- **Extending `img-src` to embed external images: don't.** Blocking remote images is the point
  (SEC-084). The sanitizer drops external Markdown images anyway, so widening `img-src` would buy
  nothing but the tracking-pixel risk back. Upload the image as an attachment instead.

## Where the worker runs

A dedicated worker's CSP comes from **its own script response**, not the page. The Argon2id worker is
a `/_next/static` file, so it runs under the static baseline (framing only); the page policy governs
whether the page may *start* it (`worker-src`). That is why `'wasm-unsafe-eval'` is on the page
policy only as a safety margin — hash-wasm compiles inside the worker.

Related: [[SEC-084-mermaid-html-labels-remote-image-load]] · [[0029-untrusted-content-sanitization]] ·
[[0026-reverse-proxy-tls]] · [[deploy-self-hosted]] · [[_MOC|Security]]
