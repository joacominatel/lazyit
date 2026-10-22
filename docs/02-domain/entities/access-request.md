---
title: AccessRequest
tags: [domain, entity]
status: active
created: 2026-05-25
updated: 2026-10-21
---

# AccessRequest

> 🟢 built (backend) · Area: Access · Implementation order: 5 · [[0085-access-request-flow]]

> [!note] History
> Access management originally shipped **without** an approval workflow ([[0023-access-management-design]]):
> [[access-grant]]s were created **directly**. [[0085-access-request-flow]] (#948) closes that deferral —
> this note now describes the built entity. The **backend** landed first; the request/approve UI is a
> following change.

## Purpose

A [[user]]'s **self-service request** to be granted access to an [[application]], moving through a small
approval lifecycle. On **approval** it produces an [[access-grant]] through the existing grant write path
(so provisioning + audit attribution fire unchanged, [[0054-applications-workflow-engine]]); on **denial**
it records a reason. A request is a **lifecycle row** — it is born `PENDING` and closes by decision; it is
never edited or deleted (the append-only-family posture, [[0006-soft-delete-and-auditing]]).

## Relationships

- **for** a [[user]] (`requesterId`, Restrict — the requester's history is preserved).
- **filed by** a [[user]] on the requester's behalf (`filedById`, SetNull; nullable — null means the
  requester filed it themselves, which is every request before #1645).
- **targets** one [[application]] (`applicationId`, Restrict).
- **decided by** a [[user]] approver (`decidedById`, SetNull; nullable — a HUMAN, no service-account decider).
- **produces** one [[access-grant]] when approved (`grantId`, `@unique`, SetNull — a 1:1).

## Business rules

- **Status:** `PENDING` → `APPROVED` (a grant is produced) or `DENIED` (with a required `deniedReason`).
  `decidedAt` + `decidedById` stamp the one allowed transition.
- **One open request per (requester, application):** a second `PENDING` create is a **409**, enforced by a
  partial unique index `WHERE status = 'PENDING'` (raw SQL, [[0019-asset-assignment-integrity]]/
  [[0041-soft-delete-reuse-and-restore]] pattern). A decided request frees the pair for a later request.
- **Approval is atomic:** the [[access-grant]] is created and the request flipped to `APPROVED` in **one
  transaction**, via `AccessGrantsService.createWithinApproval` — the grant inherits the request's
  `accessLevel`. The workflow engine fires AFTER the grant commits ([[0054-applications-workflow-engine]]).
- **Approval re-checks the person (#1661):** the grant write path refuses a person who is no longer
  live, active and account-holding, so approving a request whose person was deactivated after filing is
  a **400** (`ACCESS_GRANT_PERSON_INACTIVE` for a deactivated person) and the request stays `PENDING`
  for the approver to deny. Decided 2026-10-21: no auto-deny when a person is deactivated or
  offboarded; deciding stays human-only ([[0085-access-request-flow]]); grants to inactive people are
  refused with `400 ACCESS_GRANT_PERSON_INACTIVE`.
- **On behalf of someone else (#1645, CEO 2026-10-17):** `POST /access-requests` takes an optional
  `requesterId`. Omitted or the caller's own id, nothing changes. Another person's id needs
  `accessGrant:grant`, the permission that decides requests (otherwise **403**
  `ACCESS_REQUEST_ON_BEHALF_FORBIDDEN`), and that person must be live, active and have an account (otherwise
  **400** `ACCESS_REQUEST_TARGET_UNAVAILABLE`; a directory-only person is refused because the grant an
  approval creates refuses them too). The caller is stored as `filedById`. The one-pending rule applies to
  the person the request is for. Approval is unchanged. This is the help-desk case: someone asks by phone
  or chat and an approver files the request for them. The MCP tool `access_request_create` stays
  self-only.
- **Who may act:** requesting is **self-service** (`accessRequest:create`, seeded to every role incl VIEWER);
  **deciding** reuses `accessGrant:grant` (no new verb); both approve/deny are **human-only**. Listing all
  requests needs `accessRequest:read` (ADMIN+MEMBER), but a requester always sees their **own** via
  `GET /access-requests/mine`. → [[0046-roles-permissions-v2]].
- **Self-approval is allowed (CEO 2026-09-25, #1344).** A decider holding `accessGrant:grant` may approve
  or deny their **own** request: the route does not block it and the web UI adds no warning. The AI
  assistant's approval card only states the fact ("You are deciding your own request."), without a
  warning flag or an extra step. The decision was "leave it as it is" (the same
  `accessGrant:grant` already lets that person create the grant directly). The audit trail
  still records it: `requesterId` and `decidedById` name the same person, and the grant is attributed
  to the approver.
- **Notified on create:** a broadcast `access_request.created` bell nudge to the admins who can decide
  ([[0056-in-app-notification-bell]]). A request filed on someone's behalf reads "<filer> requested access
  to <app> on behalf of <requester>" and carries `filedById` in its metadata. The requester is not told
  at filing time; the filer is not sent the decision (they hold `accessGrant:grant` and see the queue).
- **Notified on decision (#1071):** a TARGETED `access_request.decided` bell + email nudge to the
  **requester** on approve/deny (`recipientUserId = requesterId`), so it lands in their OWN bell even
  without `notification:read` — closing the earlier deferral where the requester had to poll their own
  request list. Best-effort post-commit, de-duped per request; the denial reason rides the human summary,
  metadata stays REDACTED (app name/ids + decision + accessLevel). Email is opt-out-able (issue #879).

- **Export (#1597):** `GET /access-requests/export?status=&applicationId=&requesterId=` streams every
  request the estate-wide list returns for the same filters as CSV, under the same `accessRequest:read`
  ([[0103-data-export-streaming-path]]). Columns: `Application, Requester, Requester email, Access level,
  Justification, Status, Filed by, Requested at, Decided by, Decided at, Denial reason, Grant ID, Request ID`
  (`Filed by` is empty for a self-filed request, #1645). As in
  the [[access-grant]] export, names need `application:read` / `user:read`, otherwise the cell keeps the
  id the list returns, and the email column is present only with `user:read`. `GET /access-requests/mine`
  has no export. Every export writes a [[data-export-log]] row.

> [!note] Relationship to tickets — question closed (CEO 2026-06-16)
> lazyit will NOT have a ticketing pillar (see [[vision]] non-goals). AccessRequest is a distinct entity in
> its own right — the ticket-subtype overlap question is moot.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps:** `createdAt` **only** — no `updatedAt`/`deletedAt` (append-lifecycle; closes by decision,
  [[0006-soft-delete-and-auditing]]).

Related: [[0085-access-request-flow]] · [[access-grant]] · [[application]] · [[user]]
