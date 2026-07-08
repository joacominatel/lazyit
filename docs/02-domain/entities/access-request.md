---
title: AccessRequest
tags: [domain, entity]
status: active
created: 2026-05-25
updated: 2026-07-02
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

- **raised by** a [[user]] (`requesterId`, Restrict — the requester's history is preserved).
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
- **Who may act:** requesting is **self-service** (`accessRequest:create`, seeded to every role incl VIEWER);
  **deciding** reuses `accessGrant:grant` (no new verb); both approve/deny are **human-only**. Listing all
  requests needs `accessRequest:read` (ADMIN+MEMBER), but a requester always sees their **own** via
  `GET /access-requests/mine`. → [[0046-roles-permissions-v2]].
- **Notified on create:** a broadcast `access_request.created` bell nudge to the admins who can decide
  ([[0056-in-app-notification-bell]]).
- **Notified on decision (#1071):** a TARGETED `access_request.decided` bell + email nudge to the
  **requester** on approve/deny (`recipientUserId = requesterId`), so it lands in their OWN bell even
  without `notification:read` — closing the earlier deferral where the requester had to poll their own
  request list. Best-effort post-commit, de-duped per request; the denial reason rides the human summary,
  metadata stays REDACTED (app name/ids + decision + accessLevel). Email is opt-out-able (issue #879).

> [!note] Relationship to tickets — question closed (CEO 2026-06-16)
> lazyit will NOT have a ticketing pillar (see [[vision]] non-goals). AccessRequest is a distinct entity in
> its own right — the ticket-subtype overlap question is moot.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps:** `createdAt` **only** — no `updatedAt`/`deletedAt` (append-lifecycle; closes by decision,
  [[0006-soft-delete-and-auditing]]).

Related: [[0085-access-request-flow]] · [[access-grant]] · [[application]] · [[user]]
