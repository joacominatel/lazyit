---
title: "ADR-0039: Auth.js v5 for frontend OIDC login"
tags: [adr, auth, frontend, oidc]
status: accepted
created: 2026-05-27
updated: 2026-05-27
deciders: [Joaquín Minatel]
---

# ADR-0039: Auth.js v5 for frontend OIDC login

## Status

accepted — 2026-05-27. Implements Phase 3 of the auth plan outlined in
[[0037-idp-choice-zitadel-byoi]] and [[0038-jit-user-provisioning]].

## Context

Phases 1 and 2 of the auth epic established:

- **Phase 1** ([[0037-idp-choice-zitadel-byoi]]): Zitadel as the default bundled IdP; BYOI
  contract (3 env vars: `AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`); Caddy routing.
- **Phase 2** ([[0038-jit-user-provisioning]]): NestJS global auth guard validates OIDC Bearer
  JWTs; JIT user provisioning on first login; `AUTH_MODE=shim` retained for dev without OIDC
  infra.

Phase 3 (this ADR) wires the **Next.js frontend** into the OIDC flow:

1. Present a sign-in page that redirects the user to the IdP.
2. Handle the OIDC callback and store a session in an encrypted cookie.
3. Attach the IdP access token as `Authorization: Bearer` on every API call.
4. Remove the `X-User-Id` dev shim from the frontend entirely.

The frontend previously had no real authentication: a dev `UserSwitcher` component read a user
ID from `localStorage`, and `apiFetch` injected it as an `X-User-Id` header (ADR-0022). That
shim is now removed from `apps/web`. The backend's `AUTH_MODE=shim` option is still available
for local development without OIDC infrastructure.

## Considered options

### Library choice

- **Auth.js v5 (`next-auth@beta`)** — the canonical Next.js auth library. Native App Router
  support (server actions, middleware, server components). Built-in OIDC support. JWT and
  database session strategies. Actively maintained by Vercel / the OSS community. *(chosen)*

- **NextAuth.js v4** — the predecessor. Requires `pages/` router workarounds for App Router.
  v5 is the correct choice for Next.js 13+.

- **Custom OAuth flow** — build the authorization code flow manually with `jose` (which the
  backend already uses). Correct but high implementation cost, low maintainability, no benefit
  over a library.

- **Lucia** — lightweight session library (no OAuth/OIDC built in). Would require manually
  handling the OIDC authorization code exchange and refresh. Too low-level for this use case.

### Session strategy

- **JWT session** (stateless, cookie-stored encrypted session) — chosen. No session DB
  required; self-hosted operators don't want an additional stateful dependency. The encrypted
  cookie is managed by Auth.js and signed with `AUTH_SECRET`.

- **Database session** — requires a `sessions` table in the app DB. Adds schema migration and
  query overhead. Not needed: the existing OIDC JWT (validated by the API) is the source of
  truth for identity; a duplicate server-side session adds no security benefit here.

### Token forwarding

The API requires a Bearer JWT on every request (ADR-0038). Options for getting the token to
`apiFetch`:

- **Option A — `token` parameter on `apiFetch`** — each call site passes the token from its
  session context. Server components call `const session = await auth()` and pass
  `session.accessToken`; client components use `useSession()`. Simple, explicit, no hidden
  dependency. *(chosen for initial implementation)*

- **Option B — async token resolution inside `apiFetch`** — `apiFetch` calls `auth()` or reads
  a cookie internally. Not viable: `auth()` is a server-only function; client components can't
  call it. A cookie-based fallback adds complexity and couples the API client to session
  internals.

- **Option C — React context token provider** — a context wraps the component tree and supplies
  the token to hooks. More ergonomic for nested hooks but adds indirection and requires
  `SessionProvider` at the tree root (already needed for `useSession()`). Option A is sufficient
  for Phase 3 — this can be revisited if the number of call sites grows.

Option A is the current implementation: `apiFetch` gains an optional `token?: string` parameter.
Since most data fetching is done via TanStack Query hooks (client-side) and the middleware +
AppLayout guard (server-side) already ensure users are authenticated before reaching any data
page, the access token is always available from the client session.

## Decision

### 1. Library: Auth.js v5 (`next-auth@5.0.0-beta.31`)

Auth.js v5 is installed as `next-auth@beta`. The configuration lives in `apps/web/auth.ts`
and exports `{ handlers, auth, signIn, signOut }`.

### 2. Provider: generic OIDC (inline config)

A single generic OIDC provider is configured inline in `auth.ts`:

```ts
{
  id: "oidc",
  name: "Your organization",
  type: "oidc",
  issuer: process.env.AUTH_ISSUER,
  clientId: process.env.AUTH_CLIENT_ID,
  clientSecret: process.env.AUTH_CLIENT_SECRET,
}
```

Auth.js infers the discovery document from `issuer + /.well-known/openid-configuration`.
No Zitadel-specific SDK or library is used. BYOI: swapping IdPs requires only updating
the three env vars — no code changes.

### 3. Session: JWT, access token preserved in cookie

`session.strategy = "jwt"`. In the `jwt` callback, `account.access_token` is stored in the
JWT on first sign-in. In the `session` callback it is copied to `session.accessToken` so
client components and server code can read it:

```ts
jwt({ token, account }) {
  if (account?.access_token) token.accessToken = account.access_token;
  return token;
},
session({ session, token }) {
  session.accessToken = token.accessToken ?? "";
  return session;
},
```

The TypeScript `Session` and `JWT` interfaces are module-augmented in `auth.ts` to add
`accessToken: string`.

### 4. Route handler: `app/api/auth/[...nextauth]/route.ts`

The Auth.js handlers are re-exported from `auth.ts`. This is the OIDC callback endpoint.

### 5. Middleware: `apps/web/middleware.ts`

A Next.js middleware at the web root protects the `(app)` group. Unauthenticated requests are
redirected to `/login` with a `callbackUrl` query parameter. The matcher excludes static assets,
`_next` internals, `/api/auth/**`, and `/login` so the OIDC flow can complete without recursion.

The `app/(app)/layout.tsx` server component adds a belt-and-suspenders `auth()` check and
redirects to `/login` if the session is missing.

### 6. Bearer token injection in `apiFetch`

`apiFetch` (in `lib/api/client.ts`) gains an optional `token?: string` parameter:

```ts
export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  token?: string;
}
```

When supplied, it is sent as `Authorization: Bearer <token>`. The `X-User-Id` header injection
is removed entirely.

Callers supply the token from their session context:
- **Client components / hooks**: read from `useSession().data.accessToken`
- **Server components**: read from `(await auth()).accessToken`

#### 6a. Client-side auto-injection + first-paint seeding (amendment, issue #498)

The "explicit token wiring" follow-up below was subsequently built: `apiFetch` falls back to a
module-level **session-token store** (`lib/api/session-token.ts`) when no explicit `token` is
passed, so client hooks no longer thread the token manually. `SessionTokenSync` (rendered in the
`(app)`/`(print)` layouts) reads `useSession()` and writes the token into that store.

There is a subtle race at cold load: `<SessionProvider>` originally mounted with **no** `session`
prop, so `useSession()` started `{ status: 'loading' }` and fetched `/api/auth/session` on the
client — and `SessionTokenSync` only wrote the token in a post-mount `useEffect`. During that
window the store was empty and any TanStack Query that fired sent **no** `Authorization` header →
spurious 401s (the global query `retry` masked it). Fix (#498):

- The root layout (`app/layout.tsx`) resolves the session with `await auth()` and passes it to
  `<SessionProvider session={session}>` (via `Providers`). `useSession()` is then `authenticated`
  on the **first** client render — the canonical Auth.js v5 SSR-seeding pattern.
- `SessionTokenSync` also writes the token **synchronously during render** (not only in the
  effect) so the store is populated before the component returns and before any child query's
  `queryFn` runs. The store is a plain module variable, so this is a safe, idempotent side effect;
  the effect is kept to mirror later transitions (sign-out clears it, a refresh swaps it).

No SSR/prefetch refactor (that is issue #500); `apiFetch` is unchanged — it still omits the header
only when the token is genuinely falsy (public endpoints).

### 7. Shim removal

`apps/web/lib/api/acting-user.ts` and `apps/web/components/user-switcher.tsx` are deleted.
All imports of them (KB article form, detail page, edit page, import dialog) are updated to
use `useSession()` instead. The KB "can write" check is simplified to `session != null` —
server-side authorship enforcement (the API returns 403) is the authoritative gate.

### 8. Login page and UserMenu

`app/(auth)/login/page.tsx` is replaced with a server-side form that calls `signIn("oidc")`
on submit, redirecting the user to the OIDC provider's authorization endpoint.

`components/user-menu.tsx` is updated to use `useSession()` — showing the real user name and
email from the OIDC `name`/`email` claims, and calling `signOut()` on "Sign out".

### 9. Env vars

`apps/web/.env.example` is updated with the four Auth.js env vars:

```
AUTH_SECRET=CHANGE_ME         # openssl rand -base64 32
AUTH_ISSUER=http://localhost:8080
AUTH_CLIENT_ID=CHANGE_ME
AUTH_CLIENT_SECRET=CHANGE_ME
NEXTAUTH_URL=http://localhost:3000
```

## Consequences

### Positive

- Users are authenticated against the real OIDC provider before reaching any app page.
- The `X-User-Id` shim is fully removed from the frontend. The API now receives Bearer tokens
  from real sessions.
- BYOI is preserved: the provider is configured by 3 env vars, no code changes required.
- JWT session means no session DB — the self-hosted operator's footprint does not grow.
- `useSession()` / `SessionProvider` are available app-wide for any future component that
  needs session data.

### Negative / trade-offs

- **Session cookie size**: the IdP access token (a JWT itself) is stored in the Auth.js
  encrypted cookie. Depending on the token size this may approach browser cookie limits for
  very large tokens with many claims. Mitigation: keep token claims minimal in the IdP config.
- **Token refresh not implemented**: Auth.js v5 JWT sessions do not automatically refresh the
  access token when it expires. The user will be redirected to sign in again once the session
  expires. Token rotation / silent refresh is a future work item.
- **`canWrite` is now optimistic**: the article edit controls are shown to any authenticated
  user. The API returns 403 if they are not the author. This is acceptable UX — the error is
  surfaced via the existing toast system.
- **`apiFetch` token is opt-in**: callers must pass `token` explicitly. Forgetting to pass it
  on a protected endpoint will result in a 401. Phase 4 could make this more ergonomic (e.g.
  a React context that supplies the token automatically to all hooks).

### Follow-ups

- **Token refresh** (future): implement the `jwt` callback's refresh-token rotation pattern
  from the Auth.js docs to silently renew expired access tokens.
- **Explicit token wiring** (future): as the number of TanStack Query hooks grows, consider
  a React context that supplies the session token to all hooks without explicit passing, or a
  `useApiFetch()` wrapper hook.
- **Profile sync** (future): update `firstName`/`lastName`/`email` in the lazyit `User` row
  from the latest OIDC claims on each sign-in (see [[0038-jit-user-provisioning]]).
- **`AUTH_MODE=shim`** remains available in the backend for local dev without OIDC
  infrastructure. The frontend no longer sends `X-User-Id` — developers who need the shim
  must set it in `apps/api/.env`.

Related: [[0022-draft-visibility-auth-shim]] · [[0037-idp-choice-zitadel-byoi]] ·
[[0038-jit-user-provisioning]] · [[0016-auth-strategy-deferred]]
