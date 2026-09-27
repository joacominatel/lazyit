---
paths:
  - "apps/web/**"
---

# Frontend conventions

Next.js App Router, React, Tailwind v4, shadcn/ui on the radix-nova preset.
→ `docs/03-decisions/0010-nextjs-frontend.md`, `docs/03-decisions/0011-tailwind-styling.md`

`web` and `api` never import each other. They talk over HTTP, and the contract is
`@lazyit/shared`.

## The mold

A new surface follows the established sequence: endpoint → hook → page. Data flows through
TanStack Query; forms are react-hook-form with zod resolvers against the shared schema.
→ `docs/03-decisions/0020-*`

Read `docs/04-development/ssr-prefetch-recipe.md` before adding a page that needs server-side
data, and `docs/04-development/ledger-design-language.md` before inventing a visual pattern.

## Constraints that bite

- **No `lucide-react` outside `components/ui/*`.** Icons come through the UI layer.
- **Server actions need explicit approval.** Do not reach for one because it is shorter.
- **Do not restructure navigation** without escalating. `components/sidebar-nav.tsx` and
  `app/(app)/layout.tsx` are shared critical files: touching either forces serial execution.
- **Do not invent entities.** If the surface needs data the API does not expose, that is a
  backend unit and a contract change, not a frontend workaround.

## i18n

Every user-visible string goes through the message catalogs, `en` and `es` both. The parity
check is blocking in CI:

```sh
(cd apps/web && bun run check:message-parity)
```

→ `docs/04-development/i18n.md`

## The Manual

A user-facing change is not done until `apps/web/content/manual/` is updated in **both**
languages, with `_nav.ts` wired if the page is new. `_nav.ts` is a shared critical file.

```sh
(cd apps/web && bun run check:manual-parity)
```

→ `docs/04-development/manual-authoring.md`, `docs/03-decisions/0062-*`

## Tests and lint

`bun test`. Frontend unit coverage is deliberately light and e2e is deferred — rigor lives on
core logic and in review. → `docs/03-decisions/0012-testing-strategy.md`

`apps/web` eslint has **no** prettier rule, unlike `apps/api`. Run `bunx eslint` on your changed
files from inside `apps/web`.
