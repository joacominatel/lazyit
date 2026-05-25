---
title: "ADR-0010: Next.js for the frontend"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0010: Next.js for the frontend

## Status

accepted

## Context

lazyit needs a frontend framework for an internal, data-dense app (inventory tables, asset
detail views, ticket/access workflows). We want a modern React-based stack with file-based
routing, server rendering, strong TypeScript support and a large ecosystem a small team can
lean on — without assembling routing/SSR/bundling by hand.

## Considered options

- **Next.js (App Router)** — React framework with file routing, React Server Components,
  SSR/SSG, first-class TypeScript and a huge ecosystem. Cons: opinionated, App Router has a
  learning curve, tied to its conventions.
- **Remix / React Router** — great data/forms model and web-standards focus. Cons: smaller
  ecosystem; less momentum than Next for this kind of app.
- **SvelteKit** — excellent DX and performance. Cons: not React — the team and component
  ecosystem (shadcn/ui, see [[0011-tailwind-styling]]) are React-centric.
- **Plain React SPA (Vite)** — maximal flexibility. Cons: we'd own routing/SSR/data
  patterns; `CLAUDE.md` also steers away from Vite.

## Decision

**Next.js 16 (App Router) + React 19**, TypeScript. Already the configured frontend
(`apps/web`, see [[stack]]). React keeps us aligned with the intended component layer
([[0011-tailwind-styling]]).

## Consequences

- **Positive:** batteries-included routing/SSR/RSC; large ecosystem; smooth path to
  shadcn/ui + Tailwind; strong TypeScript story.
- **Trade-offs:** App Router conventions and RSC mental model; coupling to Next's release
  cadence (currently 16.2.6).
- **Follow-ups:** authentication is deferred and will integrate with an external IdP (OIDC),
  not a self-rolled NextAuth/better-auth flow — see [[0016-auth-strategy-deferred]]. Frontend
  testing is deferred ([[0012-testing-strategy]]).
