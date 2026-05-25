# @lazyit/web

Frontend for **lazyit** — the self-hosted IT management app. Next.js (App Router) +
React + Tailwind v4 + shadcn/ui. Talks to `@lazyit/api` over HTTP; shared contracts
live in `@lazyit/shared`. See the docs vault (`docs/`) for product and architecture
context.

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui (`radix-nova` style, `neutral` base color, CSS variables) |
| Icons | **Heroicons only** (`@heroicons/react`) — see decision below |
| Fonts | Geist + Geist Mono via `next/font/google` |
| Theming | `next-themes` (system + manual, persisted) |
| Data fetching | TanStack Query (`@tanstack/react-query`) + a thin typed `fetch` wrapper |
| Toasts | `sonner` |

## Folder structure

```
app/
├── layout.tsx            # root layout — fonts, <Providers>, metadata
├── providers.tsx         # QueryClientProvider + ThemeProvider + <Toaster>
├── globals.css           # Tailwind v4 + shadcn theme tokens (neutral, oklch)
├── (marketing)/          # public marketing routes (header + footer)
│   ├── layout.tsx
│   └── page.tsx          # landing ("coming soon")
├── (auth)/               # public auth routes (centered, no chrome)
│   ├── layout.tsx
│   └── login/page.tsx    # placeholder — no real auth yet (ADR-0016)
└── (app)/                # private app routes (sidebar + topbar)
    ├── layout.tsx        # NOTE: no auth guard yet (deferred — ADR-0016)
    └── dashboard/page.tsx

components/
├── ui/                   # shadcn/ui primitives (vendored, owned in-repo)
├── theme-toggle.tsx      # light/dark switch (heroicons)
└── user-menu.tsx         # topbar avatar + dropdown (placeholder)

lib/
├── utils.ts              # cn() helper
└── api/
    ├── client.ts         # typed fetch wrapper (apiFetch / ApiError)
    └── hooks/use-health.ts  # example query hook (GET /users) — not wired to a page
```

Route groups (`(marketing)`, `(auth)`, `(app)`) don't affect the URL — they only
let each section have its own layout. `/` → marketing, `/login` → auth,
`/dashboard` → app.

## Commands

Run from the repo root (preferred — uses Turborepo):

```sh
bun run dev                         # web + api together
bun run build                       # build all workspaces
```

Or scoped to this app:

```sh
bun run --filter @lazyit/web dev    # dev server on http://localhost:3000
bun run --filter @lazyit/web build
bun run --filter @lazyit/web lint
```

Add a shadcn component (writes into `components/ui/`):

```sh
bunx shadcn@latest add <component>
```

## Environment variables

One `.env` per scope with a committed `.env.example` to copy:

```sh
cp .env.example .env
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Base URL of the lazyit API, read by `lib/api/client.ts`. `NEXT_PUBLIC_*` is inlined into the client bundle, so it must not hold secrets. |

## Decisions

- **Icons — Heroicons only.** App-authored UI uses `@heroicons/react` exclusively; do
  **not** introduce `lucide-react`, `react-icons` or any other set in our own code.
  `lucide-react` is installed, but only because the vendored shadcn/ui primitives use
  it internally (e.g. the dialog close, dropdown chevrons/checks). Treat it as an
  implementation detail of `components/ui/*` and never import it directly elsewhere.

- **Typography — Geist (+ Geist Mono).** Sans-serif, neutral and technical, with
  excellent legibility at small sizes — a good fit for the data-dense, "infrastructure"
  feel of an IT tool. It ships with the Next.js font pipeline (`next/font/google`,
  zero-CLS, self-hosted) and is the font the chosen shadcn `radix-nova` preset assumes.
  Geist Mono is reserved for code / identifiers / monospace data.

- **Dark mode — system + manual, persisted.** `next-themes` with
  `defaultTheme="system"` + `enableSystem`, so the first visit follows the OS; the
  `ThemeToggle` sets an explicit light/dark choice that persists in `localStorage`.
  The theme class is applied to `<html>` (hence `suppressHydrationWarning` in the root
  layout).

- **shadcn/ui — `radix-nova` style, `neutral` base color.** Radix primitives (per
  ADR-0011), with a neutral grayscale palette for a clean, minimal, non-flashy look.
  Components are copied into `components/ui/` and owned here.

## Status / caveats

- **No authentication yet.** Auth is deferred to an external IdP (OIDC); the API is
  open and dev-only. The `(app)` layout has no guard — see ADR-0016. The `/login` page
  and `user-menu` are visual placeholders.
- The example hook `lib/api/hooks/use-health.ts` validates the web → api chain but is
  not yet used by any page. Calling the API from the browser will require CORS to be
  enabled on the API (not yet configured).
