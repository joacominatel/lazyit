# Frontend Task Template

> Template for dispatching a frontend feature, refactor, fix, or UX-adjacent task. The agent loads the `lazyit-navigator` skill.
>
> **How to use**: same as the backend template. Replace every `<bracketed>` slot, remove unused optional sections, send.

---

```markdown
# <Task title in 5-10 words>

## Objective

<One line. What this task accomplishes when complete from the user's perspective.>

## Context

<2-4 sentences. What in the system motivates this task — usually new backend capability that needs UI, or UX gap.>

Relevant references:
- `docs/03-decisions/0020-frontend-data-layer.md` — the established mold
- `docs/03-decisions/NNNN-<adr>.md` — <if applicable>
- `apps/web/components/<component>.tsx` — <if reusing or extending an existing primitive>

## CEO intent (verbatim if a direct quote)

> "<exact CEO words, if applicable>"

## Backend contract

<If this task consumes a backend endpoint, describe it precisely.>

- Endpoint: `<METHOD> /path/to/resource`
- Query params: `<list>`
- Response shape: <link to zod schema in shared, or describe>
- Auth: <pre-auth shim header X-User-Id, currently>
- Known quirks: <pagination, soft-delete handling, etc.>

## Scope

**In scope**:
- <Pages or screens being added or modified>
- <Components being created or extracted>
- <Hooks or data flows being added>
- <Existing screens being polished>

**Explicitly out of scope**:
- <Cross-cutting refactors that should wait>
- <New entities — must be approved separately>
- <Navigation restructuring — must be approved separately>

## Lane

**You may touch**:
- `apps/web/**`
- `packages/shared/**` (consume only; do not add new schemas without CTO approval)
- `docs/03-decisions/**` (only for frontend-specific ADRs)

**You must NOT touch**:
- `apps/api/**`
- `infra/**`
- `.github/**`
- Backend zod schemas (consume only)

## Concurrent work declaration

<Same as backend template>

## Design and convention constraints

The frontend operates under established conventions. Do not deviate without raising 🚨.

- **shadcn/ui** as the component library; preset `radix-nova`, base `neutral`
- **heroicons** exclusively; lucide-react only inside `components/ui/*` vendored files
- **TanStack Query** for data; `createQueryKeys` factory pattern
- **react-hook-form + zodResolver** for forms
- **Sonner** for toasts
- **next-themes** for dark mode
- **Tailwind v4** classes only; no inline styles unless dynamic
- The **ADR-0020 mold** is canonical: `endpoint → hook → page`. Do not bypass.

## Acceptance criteria

1. <Observable user behavior>
2. <Light/dark mode parity>
3. <Empty/loading/error states present>
4. <Keyboard navigation if applicable>
5. <Mobile responsiveness if applicable>
6. <Form validation matches backend zod schema>

## UX expectations

<Be specific where it matters; trust the agent's judgment elsewhere.>

- Loading: <skeletons / spinners / nothing>
- Empty: <message + CTA if applicable>
- Error: <toast + retry / inline / 500-screen>
- Success on mutation: <toast / redirect / inline confirmation>

## Testing approach

Frontend tests are pragmatic, not exhaustive (per ADR-0012):

- Unit tests for: <pure utility functions, hooks if non-trivial>
- Component tests: <if a primitive is extracted and reused>
- Manual smoke: <browser path the agent should walk through>

## Documentation required

- ADR: <yes/no — for frontend pattern changes only>
- README update in `apps/web/README.md`: <yes/no — usually no for screens>
- Component documentation: <inline JSDoc if reusable>

## Workflow

Standard git workflow applies. Same as backend.

## Reporting

When you finish:

1. **Summary**: 3-5 lines
2. **Files changed**: list with one-line each
3. **New abstractions**: anything extracted (component, hook, util)
4. **Manual smoke verification**: which paths you walked
5. **Visual notes**: how key states look (you can describe; screenshots optional)
6. **Debt or follow-ups**: noticed but not fixed
7. **Frictions**: anything that broke convention or slowed you down

Do NOT open the PR until I confirm. Wait for my OK.

## When to stop and ask

- Any UX choice with multiple reasonable interpretations
- Any new entity, new screen-level navigation, or new layout root
- Any conflict with the ADR-0020 mold
- Any missing or ambiguous backend contract
- Any dependency you'd want to add

Raise with 🚨.
```

---

## CTO-side fill checklist

- [ ] Objective is user-facing, not technical
- [ ] Backend contract section is filled in or marked N/A
- [ ] Design constraints section is intact
- [ ] UX expectations are explicit where they matter
- [ ] No bracketed leftover text remains