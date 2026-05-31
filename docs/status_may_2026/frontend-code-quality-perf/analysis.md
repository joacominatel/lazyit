# Frontend code quality, performance, accessibility, data-layer hygiene

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Frontend / UX**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The ADR-0020 data layer is disciplined and consistent, but the app is fully client-rendered with no optimistic updates, no keepPreviousData (skeleton flash on every filter), and unbounded client-side joins — and ADR-0020's own deferred RSC migration trigger has now been met.

## Findings (10)

### 1. Entire authenticated app body is client-rendered; ADR-0020's deferred RSC-migration trigger has been met

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | medium | large | high |

- **Location:** `every app/(app)/**/page.tsx (all "use client"); app/(app)/layout.tsx:18; docs/03-decisions/0020-frontend-data-layer.md:132-138`
- **Why it matters:** The (app) layout is RSC and runs auth() server-side, but every page under it is "use client" and fetches via TanStack Query after hydration. ADR-0020 explicitly deferred RSC+Server Actions until 'auth lands and reads can run on the server with a session' and pre-committed to revisiting it then. Auth has now landed (ADR-0038/0039); client.ts already accepts an explicit server token. This is the single biggest structural improvement available, and the endpoints/ layer was designed to survive the migration.
- **Recommendation:** PROPOSAL acting on ADR-0020's own deferred decision (not superseding): pilot one read-heavy screen (Assets) — fetch server-side in the RSC using existing endpoints/ + await auth() token, hydrate TanStack Query via initialData/HydrationBoundary, keep mutations client-side. Measure TTFB/LCP, then write a follow-up ADR.

### 2. List queries lack keepPreviousData — every filter/search keystroke flashes skeleton rows

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | quick-win | high |

- **Location:** `lib/api/hooks/use-assets.ts:25-30, use-consumables.ts, use-articles.ts, use-access-grants.ts:18-23 (vs use-search.ts:37-43)`
- **Why it matters:** Assets/Consumables/KB lists feed server-side filters into the query key, so each debounced change creates a new key with no cached entry, isLoading flips true, and the table blanks to skeletons. Only useSearch opted into placeholderData: keepPreviousData — the list hooks did not. Jarring flash for the operator on a common action; the in-repo search hook already proves the one-line fix.
- **Recommendation:** Add placeholderData: keepPreviousData to useAssets/useConsumables/useArticles/useAccessGrants; pair with a subtle isFetching affordance so stale-while-revalidating reads as intentional.

### 3. No optimistic updates anywhere; every mutation is a full round-trip + invalidate-all refetch

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | medium | medium | high |

- **Location:** `lib/api/hooks/*-mutations.ts e.g. use-asset-mutations.ts:12-40, use-access-grant-mutations.ts:15-38`
- **Why it matters:** Every mutation hook does onSuccess -> invalidateQueries({queryKey: <entity>Keys.all}); since all is the common prefix, one write refetches list+detail+nested sub-queries. The grant/revoke hook invalidates two whole resource trees. No onMutate anywhere (grep confirms). ADR-0020 lists optimistic updates as the advantage of going client-side, yet none exist — the app pays the client-fetch cost without its main upside.
- **Recommendation:** Start with highest-frequency low-risk writes (useUpdateUser isActive toggle, consumable stock movements): onMutate snapshot+patch, onError rollback, onSettled invalidate. Where a write changes one record, invalidate the detail key, not all.

### 4. Unbounded full-list fetches joined client-side — frontend half of the missing pagination (SEC-007)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | medium | medium | high |

- **Location:** `lib/api/hooks/use-users.ts:13-18; applications/page.tsx:86-130; applications/[id]/page.tsx:56-95; kb/page.tsx:56-61`
- **Why it matters:** useUsers fetches all users and is called from 9 screens; the Access list joins all apps x all active grants x all users in useMemo, and the KB list resolves author/category via users.find per row (O(rows x users)). No list endpoint is paginated (SEC-007/ADR-0030 contract unimplemented). The sensitive access-grants list is pulled whole into the client; append-only grant history grows unbounded by design.
- **Recommendation:** Flag jointly with backend SEC-007/ADR-0030. Short-term: replace per-row .find with the memoized-Map pattern already used in applications/page.tsx. Medium-term: prefer backend-expanded reads (Asset list already returns AssetWithRelations with zero client join) over three-collection client joins.

### 5. No loading.tsx, not-found.tsx, or root global-error.tsx boundaries

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | quick-win | high |

- **Location:** `app/ (global-error.tsx/not-found.tsx/loading.tsx absent, verified); app/(app)/error.tsx`
- **Why it matters:** Only (app)/error.tsx exists (and is good — surfaces request id). A mistyped or deleted-detail URL falls back to Next's default 404 outside the app shell; a crash in Providers/RootLayout shows the unstyled default with no global-error. The product mandate is loud, actionable errors and a coherent shell.
- **Recommendation:** Add styled app/not-found.tsx (link back to /dashboard) and app/global-error.tsx (own html/body). Add per-segment loading.tsx if reads move to RSC (#1).

### 6. SEC-003 stored-XSS risk is materially lower than the 'escalates to High on render' framing — react-markdown@10 sanitizes by default

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | small | high |

- **Location:** `components/markdown-view.tsx:14-31; node_modules/react-markdown/lib/index.js:124,320,421-438`
- **Why it matters:** Verified in node_modules: react-markdown@10.1.0 runs defaultUrlTransform with safeProtocol=/^(https?|ircs?|mailto|xmpp)$/i, neutralising javascript: links without DOMPurify; rehype-raw is NOT enabled, so raw HTML is escaped. Both classic markdown XSS vectors are already closed by library defaults. SEC-003/ADR-0029 treat the renderer as the escalation point; residual risk is much narrower (only re-opens if someone adds rehype-raw / overrides urlTransform / uses dangerouslySetInnerHTML — none of which the code does).
- **Recommendation:** Don't reflexively add a heavy sanitizer. Coordinate with Sentinel to update SEC-003/ADR-0029 to record the default coverage; add a grep/lint guard or comment forbidding rehype-raw/dangerouslySetInnerHTML in markdown-view.tsx; add a unit test asserting <script> and javascript: links render inert.

### 7. Module-level mutable session token races the first query on a fresh session

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | low | small | medium |

- **Location:** `lib/api/session-token.ts:13-25; components/session-token-sync.tsx:15-23; lib/api/client.ts:58,66`
- **Why it matters:** apiFetch resolves the bearer from a module-level let _token written by SessionTokenSync in a useEffect after useSession() resolves. Despite the comment, there is no ordering guarantee that the effect runs before a client page's queryFn fires on mount, so the first query of a fresh session can go out with no Authorization header and 401, relying on retry to recover. SSR guard is correct (no cross-request leak), so this is robustness, not a leak.
- **Recommendation:** Gate queries on enabled: status === 'authenticated' from useSession(), or read the token from useSession() and pass it explicitly to the endpoint (the token param already exists), removing the module-global.

### 8. Duplicated detail-page scaffolding (Panel/Detail, not-found block) and two near-identical stacked-avatar components

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| refactor | low | small | high |

- **Location:** `assets/[id]/page.tsx:302-331 vs applications/[id]/page.tsx:319-348; not-found blocks in assets/[id], applications/[id], kb/[slug]; stacked-user-avatars.tsx vs stacked-owner-avatars.tsx`
- **Why it matters:** Panel and Detail helpers are copy-pasted verbatim in the asset and application detail pages; the not-found/error fallback is hand-rolled three times; two stacked-avatar components differ only in input shape. ADR-0020's own promotion criterion ('the third screen makes duplication real') has been crossed — drift risk and slower path for the next pillar's detail screens.
- **Recommendation:** Promote Panel/Detail to components/detail-panel.tsx and a <NotFoundCard> to components/; unify the two avatar stacks into one <StackedAvatars users={AvatarUser[]} /> (the comment already plans this on 3rd reuse).

### 9. as Resolver<TFormValues> cast plus hand-written form-values types reintroduce the contract drift ADR-0020 set out to remove

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | small | medium |

- **Location:** `asset-form.tsx:46-56,107-110; user-form-dialog.tsx:91-96; article-form.tsx:81-86`
- **Why it matters:** Multi-schema forms pick the resolver with zodResolver(...) as Resolver<XFormValues> and maintain a parallel hand-written XFormValues type. The cast discards the type relationship to the shared zod schema, so a field typo or schema divergence is not caught despite strict mode — the exact drift sourcing types from @lazyit/shared was meant to prevent.
- **Recommendation:** Derive form-values from the shared schemas (z.input<typeof CreateXSchema>) instead of hand-writing them; narrow the resolver per mode where possible; at minimum add a type-test asserting XFormValues is assignable from the schema's inferred type so drift fails loudly.

### 10. Accessibility: dynamic loading/error states unannounced; command palette results lack aria-live

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | medium |

- **Location:** `components/global-search.tsx:158-222; components/resource-table.tsx:92-113; assets/[id]/page.tsx:48-56`
- **Why it matters:** Base a11y is solid (html lang, aria-labels on icon buttons, sr-only dialog title, aria-current on nav, FieldError). Gaps are dynamic-state announcements: the ⌘K palette results region has no aria-live, so screen-reader users aren't told results changed / 'no results' / 'searching'; table skeletons and filtered-empty rows are silent. The palette is a primary nav surface, making its silence the most impactful gap.
- **Recommendation:** Add aria-live="polite" to the CommandList results region and the table empty/error states; role="status" on inline detail-page skeleton containers. All small attribute additions.

## Quick wins

- Add placeholderData: keepPreviousData to useAssets/useConsumables/useArticles/useAccessGrants — kills the skeleton flash on every filter/search change; one line each, pattern already exists in use-search.ts (#2)
- Add styled app/not-found.tsx and app/global-error.tsx so bad URLs and root-layout crashes stay in the app shell (#5)
- Lower the global staleTime (or set it on the reference-list hooks) so just-created users/locations/categories appear immediately across flows (providers.tsx:13-21) (#8)
- Add aria-live="polite" to the command-palette results region and table empty/error states; role="status" on inline skeletons (#10)
- Replace per-row users.find/categories.find in kb/page.tsx and applications/[id]/page.tsx with the memoized-Map pattern already used in applications/page.tsx (#13/#11)

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
