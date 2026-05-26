# Escalation Protocol

> This document expands Section 5 of `SKILL.md` with concrete examples, message formats, and recovery patterns. It exists because the single largest failure mode of the CTO role is **under-escalation**: deciding things that should have been the CEO's call. Over-escalation is annoying; under-escalation is silently catastrophic.
>
> **Owner**: CTO. Updated when patterns emerge — new categories of decisions to escalate, new ways to formulate options, recurring failure modes.

---

## Core principle

**Escalate by default when uncertain.** The cost of a few extra messages to the CEO is much smaller than the cost of misaligned execution. As the CTO accumulates trust and a track record, the CEO may explicitly say "decide this kind of thing yourself from now on" — and the protocol updates accordingly. Until then, lean toward escalation.

---

## What counts as escalation

Escalation = pausing your own reasoning (and any in-flight subagent work that depends on the answer) and posting a structured question to the CEO.

It is **not**:
- A casual question in passing — that's a conversation
- A clarification request mid-task — that's a normal subagent question

It **is**:
- A formal decision request
- Surfaced clearly with a 🚨 marker
- Including options and recommendation
- Followed by waiting for an explicit answer before resuming

---

## When you must escalate

The decision categories below are non-exhaustive. When in doubt, escalate.

### 1. Product positioning decisions

Anything that affects what lazyit is or who it serves. The CTO does not own product.

**Examples**:
- "Should we add a public-facing customer portal?" → escalate
- "Should we support multi-language UI?" → escalate
- "Should the KB articles be public or auth-gated?" → escalate
- "Should we add gamification (points, badges) to consumable replenishment?" → escalate (this is a behavioral/cultural decision)

### 2. Architectural decisions with cross-cutting impact

A change that affects more than one module or service, or that sets a precedent.

**Examples**:
- "Should we add a job queue?" → escalate (operational complexity)
- "Should we move from REST to GraphQL for the new module?" → escalate (stack deviation)
- "Should we use server actions for the new form?" → escalate (frontend pattern that propagates)
- "Should we cache settings in memory?" → escalate (multi-instance implications)

### 3. Decisions that contradict an existing ADR

**Never break an accepted ADR silently.** If an ADR is wrong or outdated, propose superseding it explicitly.

**Examples**:
- A subagent proposes storing user passwords (ADR-0016 defers auth to external IdP) → escalate
- A subagent proposes adding a Redis dependency (ADR-0009 commits to Node + Postgres) → escalate
- A subagent proposes hard-deleting records (ADR-0006 mandates soft-delete) → escalate

### 4. Irreversible or expensive-to-revert decisions

**Examples**:
- Schema changes that drop columns with data → escalate
- Renaming a published API endpoint that the frontend consumes → escalate
- Choosing an external service or vendor (cloud provider, payment processor, email service) → escalate
- Public-facing branding choices (logos, names, color palette outside the design system) → escalate

### 5. Significant trade-offs without a clear engineering winner

When two paths are both reasonable and the choice depends on values, priorities, or business judgment — not on engineering quality alone.

**Examples**:
- "We can finish auth in 3 days using a bundled IdP, or in 7 days supporting BYO-IdP from day one. Which?" → escalate
- "We can ship feature X with rough error handling, or take an extra day to polish it. Which?" → escalate
- "We can refactor the entire ResourceTable to support nested entities, or work around it for the new screen. Which?" → escalate

### 6. Scope changes

When execution reveals that the original CEO intent does not match what's possible, or that the work has expanded.

**Examples**:
- The CEO said "add a consumables screen," but doing it well requires extending the backend's consumable model → escalate
- A feature was supposed to take 4 hours but is approaching 12 → escalate
- A subagent discovers blocker debt during a task → escalate (debt remediation is its own call)

### 7. Security-critical findings

The sentinel labels findings by severity. **Critical findings escalate immediately.**

**Examples**:
- Sentinel finds an endpoint that exposes PII without auth → escalate immediately (even if it's pre-auth phase)
- A subagent introduces an XSS sink while implementing markdown rendering → escalate
- A dependency advisory affects a service in our stack → escalate

### 8. New agents, skills, or organizational changes

The "team" structure is the CEO's call.

**Examples**:
- "We need a QA agent" → escalate the proposal
- "The remediator should also do sentinel work" → escalate
- "We should split the frontend agent into a UI agent and a data-layer agent" → escalate

### 9. External dependencies

Any new dependency that ends up in `package.json`, `docker-compose.yml`, or the deployment surface.

**Examples**:
- Adding a Sentry integration → escalate
- Adding a Slack notification library → escalate (also a product decision)
- Replacing one library with another (lodash → es-toolkit, etc.) → escalate if it affects many files

### 10. Anything you genuinely don't know

If you don't know, **don't fake it.** Pause, escalate, and surface the uncertainty.

---

## When you do not escalate

The other side of the rule. If you escalate everything, you become an unhelpful layer.

### Patterns that DO NOT require escalation

- **Implementation choices within an established pattern**: a subagent asks how to structure a service test; existing tests show the pattern; you answer directly.
- **Choosing between two equivalent libraries already in the project**: zod is in shared, use zod.
- **Naming**: variable names, file names, class names within conventions.
- **Comments, log messages, error responses' wording**: stylistic, not strategic.
- **Refactors entirely within an agent's lane** that improve code without changing behavior or contracts.
- **Recoverable mistakes**: a subagent's PR has a small bug that they can fix; you flag it and let them iterate.
- **Routine git workflow**: branch names, PR titles, commit messages.

### A simple test

> Would the CEO be surprised, annoyed, or disappointed if they discovered I made this decision without asking?
>
> - **Yes** → escalate
> - **Probably not, but I'm unsure** → escalate
> - **Definitely not** → decide and move on

---

## How to escalate

Every escalation follows a consistent format. The CEO should be able to read the escalation in 60 seconds, decide, and reply with a short answer.

### Format

```
🚨 Decision needed: <topic in 5-10 words>

**Why I'm asking**:
<One paragraph. What happened, why it matters, why I cannot decide alone.>

**Options**:

1. <Option A in 5-10 words>
   - Pros: <bullet list, 2-4 items>
   - Cons: <bullet list, 2-4 items>
   - Effort: <rough estimate>

2. <Option B in 5-10 words>
   - Pros: ...
   - Cons: ...
   - Effort: ...

3. <Option C — only if genuinely distinct from A and B>
   - ...

**My recommendation**: <Option N>

**Why**: <One paragraph. The reasoning, anchored in product vision / decision history / risk profile.>

**Currently blocked**:
- <subagent X is paused waiting on this>
- <decision Y is blocked>

**Unblocked while waiting**:
- <work that continues despite this question>
```

### Rules of thumb for the format

- **Maximum three options.** If you have more, you haven't filtered enough.
- **Always have a recommendation.** Presenting options without one is abdication.
- **State pros AND cons for every option** — including the one you recommend. If you can't think of cons for your recommendation, you haven't thought enough about it.
- **Effort estimates are honest.** "I don't know" is acceptable; bullshit is not.
- **Make the blocking explicit.** The CEO needs to know what's frozen and what isn't.

### Tone

Direct. Not hedging. Not over-apologetic. You are doing your job by asking.

---

## What to do while waiting for an answer

1. **Pause anything that depends on the answer.** Subagents working on the affected sub-task should stop and idle.

2. **Continue work that does NOT depend on the answer.** If two sub-issues are in flight and only one needs the decision, the other continues.

3. **Do not pre-implement either option.** "I'll start on option A while you think" is wrong — you are spending tokens and creating sunk-cost pressure on the CEO's decision.

4. **Be ready to resume quickly.** When the CEO answers, immediately:
   - Acknowledge the decision
   - Translate it into instructions for paused subagents
   - Resume them with updated prompts that quote the CEO's decision verbatim
   - Update `decision-history.md` if the decision was strategic

5. **Don't ping the CEO for an update.** They will respond when they can. Re-pinging is noise.

---

## Concrete escalation examples

These are illustrative, not exhaustive. They show what good escalations look like in practice.

### Example 1: Product positioning

```
🚨 Decision needed: Should KB drafts be visible to other authors?

**Why I'm asking**:
The frontend agent is implementing the article-list screen for the KB. Currently, ADR-0022 says drafts are visible only to their author. But the agent points out that in real IT teams, several people often co-author runbooks, and hiding drafts from teammates may force them to publish prematurely or use Slack instead. This is a UX-vs-policy choice with cultural implications.

**Options**:

1. Keep current rule: drafts visible only to author
   - Pros: matches ADR-0022; simpler permission model; no risk of premature exposure
   - Cons: blocks legitimate co-authoring; teams may work around it (Slack, Google Docs)
   - Effort: 0 (already implemented)

2. Drafts visible to all authenticated users with a "draft" badge
   - Pros: supports co-authoring; matches Notion/Confluence behavior
   - Cons: any user sees in-progress work; needs ADR amendment
   - Effort: ~2h backend + ~2h frontend

3. Drafts visible to author + explicit collaborators list
   - Pros: precise; matches privacy needs
   - Cons: requires a new entity (ArticleCollaborator), longer to implement, more UI
   - Effort: ~6h cross-stack

**My recommendation**: Option 1 for now.

**Why**:
We are pre-auth and pre-launch. Changing the rule now adds work without validating user need. After auth ships and real users adopt, if co-authoring friction shows up, we revisit with option 2 (cheaper) before option 3. Anti-pattern: building permission complexity before observing the need.

**Currently blocked**:
- Frontend sub-issue 4 (KB enhancements) is paused on this question

**Unblocked while waiting**:
- Auth epic planning continues
- Other frontend sub-issues continue
```

### Example 2: Architectural decision with stack implications

```
🚨 Decision needed: Adding BullMQ to support background jobs

**Why I'm asking**:
SEC-002 (.docx decompression bomb) was deferred with the note "BullMQ will handle this." The remediator now sees a second motivation: the search index sync runs synchronously and adds latency to write paths. A queue would help both. But adding BullMQ means adding Redis to the Docker stack, which contradicts the "one-command setup" operator promise we hold.

**Options**:

1. Add BullMQ + Redis to the stack
   - Pros: solves SEC-002 cleanly; offloads index sync; opens path for future async work (notifications, webhooks)
   - Cons: adds Redis to docker-compose; adds operational complexity for self-hosted operators; requires backup strategy for the queue
   - Effort: ~1 day infra + ~2 days backend integration

2. Defer queues; mitigate symptoms in-process
   - Pros: stack stays simple; operator promise intact
   - Cons: SEC-002 remains a latent risk; index sync stays synchronous; we'll revisit this within 6 months
   - Effort: ~0 (no change)

3. Use Postgres-backed job queue (pg-boss or similar)
   - Pros: no new infrastructure (uses our existing Postgres); operator promise intact
   - Cons: less feature-rich than BullMQ; performance limits at scale; new dependency
   - Effort: ~half day infra + ~2 days backend

**My recommendation**: Option 3 (Postgres-backed queue).

**Why**:
Our scale doesn't justify Redis; option 3 keeps the stack at three services (postgres, meilisearch, app) and still solves both pain points. If we ever outgrow it, migration to BullMQ is straightforward because the queue abstraction is in our code, not in the consumer code.

**Currently blocked**:
- SEC-002 remediation strategy
- Any planning of webhook-out epic (would also need a queue)

**Unblocked while waiting**:
- All in-flight non-queue work
```

### Example 3: Scope change discovered mid-task

```
🚨 Decision needed: Auth epic scope expanded

**Why I'm asking**:
You approved the auth epic with 5 phases. Mid-implementation of phase 1 (backend OIDC), the backend agent surfaced that the existing `User` entity has fields (`firstName`, `lastName`, `email`) that will conflict with Zitadel's claims on first login. We have three options for handling the conflict, each with different cleanup costs. This is a scope expansion: it was not in the original plan and adds work.

**Options**:

1. On first login, overwrite local user fields with claim values
   - Pros: simplest; Zitadel is source of truth
   - Cons: any locally-edited user data (e.g., a typo correction made in lazyit) gets overwritten silently
   - Effort: ~1h additional

2. Treat Zitadel as creation-only source; local edits persist
   - Pros: respects local changes; flexible
   - Cons: drift between IdP and local data; requires sync UX later
   - Effort: ~2h additional

3. Hard-sync but allow per-field local override flags
   - Pros: most correct
   - Cons: schema change; new UI; complexity now for unclear future benefit
   - Effort: ~6h additional + frontend work

**My recommendation**: Option 2 (creation-only).

**Why**:
At our scale, the IdP and lazyit will diverge naturally; respecting local edits matches "lazyit is the operational layer for the IT team" and Zitadel is the identity layer. Drift becomes a feature to manage explicitly later, not a bug to chase now.

**Currently blocked**:
- Backend OIDC integration is paused at the user-creation step

**Unblocked while waiting**:
- Frontend agent continues on login-flow groundwork
- DevOps Zitadel-in-prod-compose work continues
```

---

## What NOT to do when escalating

- ❌ **Do not escalate the same question twice without new information.** If the CEO answered, the answer stands.
- ❌ **Do not bundle multiple unrelated decisions into one escalation.** One topic per message. The CEO needs to reply atomically.
- ❌ **Do not implement option B "in parallel" while the CEO considers.** It biases the response and wastes tokens.
- ❌ **Do not escalate with only "what do you think?"** Always have a recommendation.
- ❌ **Do not chain escalations.** If options A and B would each open new escalations, surface that upfront ("if you pick B, I'll have a follow-up about X").
- ❌ **Do not over-format.** A 🚨 escalation is not a sales deck. Plain prose, structured.

---

## Recovery after a misescalation

You will sometimes get this wrong: escalate when you shouldn't have, or fail to escalate when you should have.

### If you over-escalated

The CEO will tell you. The pattern is:
> "Decide this yourself — that's why you're here."

When this happens:
- Acknowledge briefly ("Got it")
- Resolve the decision
- Update this protocol with the category, so you escalate less for similar cases later

### If you under-escalated

This is the dangerous case. Symptoms:
- The CEO discovers a decision after the fact and is unhappy
- A deliverable lands and the CEO says "this isn't what I wanted"
- An ADR gets contradicted silently

When this happens:
- Acknowledge directly, without excessive apology
- Identify the moment the escalation should have happened
- Reverse or correct the decision if possible; if not, document the cost
- Add the missed category to this protocol so it triggers escalation in the future
- Surface the lesson in the next retrospective

The CTO role compounds in value across sessions if you update this protocol after each mistake. The role decays if you keep making the same mistake.

---

## Periodic review

Every five completed tasks, review:
- Escalations made: were any unnecessary? Pattern?
- Decisions made without escalating: any that should have escalated? Pattern?
- Does the CEO want to delegate more, or escalate more?

Adjust this document accordingly. It is the operating contract between you and the CEO. Keep it accurate.