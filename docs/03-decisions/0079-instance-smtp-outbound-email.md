---
title: "ADR-0079: Instance SMTP + outbound email for notifications"
tags: [adr, notifications, email, smtp, settings, security, async, worker]
status: proposed
created: 2026-06-30
updated: 2026-06-30
deciders: [Joaquín Minatel]
---

# ADR-0079: Instance SMTP + outbound email for notifications

## Status

**proposed** — 2026-06-30 (issue #615). Extends [[0056-in-app-notification-bell]] (adds an EMAIL
channel behind `NotificationsService.emit()`) and [[0053-async-workers-bullmq-valkey]] (delivery rides
BullMQ). Relates to [[0028-secrets-and-config]] / [[0054-applications-workflow-engine]] (the encrypted
server-secret precedent). Awaiting CTO/CEO ratification of the forks in §Decision.

> **Note on ADR-0052:** the brief flagged a possible "stale ADR-0052 SMTP draft". There is none —
> [[0052-ci-parallel-docker-and-decoupled-verify]] is about CI Docker parallelization. This ADR does not
> supersede it. No prior SMTP ADR exists; this is the first.

## Context

lazyit has an in-app notification bell ([[0056-in-app-notification-bell]]) but **no outbound email**.
Small self-hosted teams (5–20 people) live in Slack/inbox, not staring at the app — the #615 people-panel
scope note (Dave/Marcus) asks to route the curated operational nudges (low stock, workflow-needs-human,
run failed, etc.) to **email**, with a **webhook/Slack** channel as a fast-follow.

Constraints and existing seams we build on (climb the ladder — reuse, don't reinvent):

- **Notification emit seam.** `NotificationsService.emit()` (ADR-0056) is the single, idempotent,
  best-effort post-commit path every emitter already calls. It knows the audience model: **broadcast**
  (`recipientUserId = null` → every `notification:read` holder) vs **targeted** (`recipientUserId = U` →
  U's own bell). Email should be a CHANNEL behind this one seam — not sends scattered across emitters.
- **Async workers.** [[0053-async-workers-bullmq-valkey]] gives us BullMQ on Valkey with the in-process
  `@Processor`/`WorkerHost` pattern (workflow-run, import-commit). Email delivery must ENQUEUE, never
  block the request.
- **Singleton instance-config.** [[0063-configurable-asset-tag-scheme]] established the singleton
  admin-only config store (`AssetTagScheme`: one row pinned by a migration CHECK, `settings:manage` +
  `ServicePrincipalForbiddenGuard`, an explicit default instead of a 404). SMTP config is the same shape.
- **Encrypted server secret.** The SMTP password is a **server-managed machine credential** — the server
  MUST read it to authenticate to the relay. That is the **explicit inverse of the zero-knowledge Secret
  Manager** ([[0061-secret-manager-zero-knowledge]], INV-10, user-keyed) and exactly the threat model of
  the workflow engine's `WorkflowSecret` (AES-256-GCM at rest under a server env key). There is **no
  general server-encrypted "SystemSecret" settings store** yet (it is referenced as a planned key axis in
  ADR-0054/the schema, never built) — SMTP is its first consumer.

## Decision

Add a singleton **`SmtpSettings`** instance-config store + a BullMQ **email-dispatch** worker, wired as a
channel behind `emit()`.

### 1. Config store — singleton `SmtpSettings` (mirrors AssetTagScheme)

One row pinned to `id = 'singleton'` by a migration CHECK. Fields: `enabled` (master on/off for outbound
email), `host`, `port`, `security` (`none` | `starttls` | `tls`), `username`, the encrypted password
envelope columns (`passwordCiphertext`/`passwordIv`/`passwordAuthTag`/`passwordKeyVersion`),
`fromAddress`, `fromName`, `rejectUnauthorized`. Mutable config → `createdAt`+`updatedAt`, **no
`deletedAt`** (same posture as AssetTagScheme). Surface: `GET`/`PUT /config/smtp` + `POST
/config/smtp/test`, all gated `settings:manage` + `ServicePrincipalForbiddenGuard`.

### 2. The SMTP password — encrypted at rest, write-only, its OWN key axis

- **At rest:** AES-256-GCM (same `{ciphertext,iv,authTag,keyVersion}` envelope as `WorkflowSecret`),
  implemented as a standalone `node:crypto` helper (`smtp.crypto.ts`) — deliberately **not** the
  `@lazyit/shared/crypto` primitives (those pull in ESM `@noble/*` which apps/api's CommonJS Jest must
  never load — the crypto-barrel custodian rule; `secret.service.ts` uses `node:crypto` for the same
  reason).
- **Key axis:** a **NEW, dedicated** env key **`SMTP_SECRET_KEY`**, separate from `WORKFLOW_SECRET_KEY`
  ("one key per subsystem", the documented ADR-0054 posture). **OPTIONAL** (differs from the workflow key,
  which is fail-loud-at-boot): the app boots without it and email is simply unavailable; the key is
  required **only when an admin saves a password** (a clean **409** otherwise). Backed up alongside
  `.env.prod`, but a cheap-to-recover "nice to have", not a DR linchpin ([[backups]]).
- **Write-only on the wire:** `GET` returns only `passwordSet` (never the value/ciphertext). On `PUT`,
  omitting/empty `password` **keeps** the stored one; a non-empty value sets/rotates it.

### 3. Delivery — BullMQ worker, fail-soft

`emit()`, right after it writes a NEW (non-deduped) notification, calls a `NotificationEmailRelay` which
— if the type is on the curated allowlist — enqueues one job on the `email-dispatch` BullMQ queue. An
in-process `@Processor`/`WorkerHost` resolves the recipient emails, renders the template, and sends via
nodemailer. **Fail-soft end-to-end** (fork #4): the enqueue is wrapped and never throws back into
`emit()`; a send failure is retried within BullMQ's bounded attempts and otherwise dropped — email never
affects the in-app notification or the originating domain write. `nodemailer` is the mailer (zero extra
runtime deps of note; `transporter.sendMail` for both the queued send and the inline test).

### 4. Event → email set (the "start small" allowlist) — **fork #1**

A single **global on/off** (`SmtpSettings.enabled`) + a flat, code-level allowlist of notification types
that ALSO go to email — **no per-event rules engine**. The allowlist is the clearly-operational set:
`critical_app_access`, `admin_granted`, `low_stock`, `workflow.manual_task`, `workflow.run_failed`.
Bell-only in v1 (candidate additions): `secret.vault_setup` (a per-user login nudge), `permission_widened`
+ `infra.agent_offline` (the sensitive-audit stream, #852). Email **audience mirrors the bell exactly**
(broadcast → `notification:read` holders with an email; targeted → that one user).

### 5. Opt-out — **fork #1b (the brief's premise was false)**

The brief said "reuse the EXISTING per-user notification preferences for opt-out". **No such preferences
system exists** (verified — no model, no endpoint). v1 therefore ships a **global on/off only**; per-user
email opt-out is a **follow-up** (would add a `User` opt-out flag + a filter in recipient resolution).

### 6. Format — one branded template — **fork #2**

Multipart **HTML + plain-text**, ONE simple branded template (the Ledger/lazyit look — oxblood accent),
no per-type layouts, no templating framework. Subject = the notification title; body = title + summary +
a single "View in lazyit" link to the app root (not a per-entity deep link — a documented ceiling).

### 7. Test action — real send — **fork #3**

`POST /config/smtp/test` sends a **real one-off** email to a provided address using the saved config
(email need not be enabled), returning `{ ok, error }` — a real send confirms end-to-end deliverability,
not just `verify()`. A bad relay yields `ok:false` + a short non-secret error, never a crash.

### 8. TLS posture — **fork (security default)**

`rejectUnauthorized` defaults **true** (secure — reject an unverifiable cert), with an admin toggle to
allow a self-signed cert on a self-hosted relay (opt-in insecurity). `security` maps to nodemailer as:
`tls`→`secure:true`, `starttls`→`secure:false`+`requireTLS:true`, `none`→plaintext.

## Forks requiring CTO/CEO ratification

1. **Allowlist (§4):** the five operational types above. OK to add `infra.agent_offline` /
   `permission_widened` later?
2. **No per-user opt-out (§5):** global on/off only in v1 (the "reuse existing prefs" premise was false).
   Accept as a follow-up?
3. **A second server-held master key `SMTP_SECRET_KEY` (§2):** new outbound egress + a new (optional) key
   in `.env.prod`. Accept the dedicated key axis (vs reusing `WORKFLOW_SECRET_KEY`)?
4. **Real test send (§7)** and **`rejectUnauthorized` default true (§8)** — confirm.

## Consequences

- **Good:** email unlocked reusing every existing seam (emit, BullMQ, singleton config, the WorkflowSecret
  crypto shape). Fail-soft: email can never break a notification or a request. Write-only password.
- **Cost:** a new outbound SMTP egress + a new (optional) server-held key — a DB+`.env` dump now also
  exposes the SMTP credential (same posture as `WORKFLOW_SECRET_KEY`; captured in [[backups]]).
- **Out of scope (follow-ups, not built):** the webhook/Slack channel (folded onto #615 as a fast-follow),
  a per-event rules engine, per-user email opt-out, bounce/unsubscribe handling, digest emails,
  per-entity deep links, key rotation (the `keyVersion` stamp leaves room).

## Honoured invariants / related ADRs

- **INV-6 (write-only secrets):** the SMTP password is never echoed — only `passwordSet`.
- **INV-10 untouched:** this is a SERVER-managed credential, the deliberate inverse of the zero-knowledge
  Secret Manager — no overlap, no server key over user vault values.
- Extends [[0056-in-app-notification-bell]] · [[0053-async-workers-bullmq-valkey]]; mirrors
  [[0063-configurable-asset-tag-scheme]] (singleton config) and the `WorkflowSecret` crypto of
  [[0054-applications-workflow-engine]]; recorded in [[backups]].

## Alternatives considered

- **Reuse `WORKFLOW_SECRET_KEY` for the SMTP password** — zero new env, but couples two subsystems'
  key axes against the documented "one key per subsystem"; rejected for a dedicated (optional) key.
- **Reuse the `WorkflowSecret` model/table** — its shape needs an `applicationId`; wrong fit for a
  singleton settings secret. We store the envelope columns inline on `SmtpSettings` instead.
- **Send inline in `emit()`** — would block the request and couple email failures to the domain write.
  Rejected for the BullMQ enqueue (ADR-0053).
- **A per-event routing matrix / rules engine** — over-engineered for a 5–20-person tool; a flat allowlist
  + one global switch is the lazy-correct routing.
