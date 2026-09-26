---
title: UserSession
tags: [domain, entity, auth, security]
status: accepted
created: 2026-09-26
updated: 2026-09-26
---

# UserSession

> 🟢 implemented (API) · Area: Users — local authentication · issue #1420 · see
> [[0086-local-authentication-mode]] §9

## Purpose

One row per signed-in device in `AUTH_MODE=local`. Before it existed a local session was a stateless token
checked against the user's `sessionEpoch`, so the only way to end one was to end them all. The row lets a
user see where they are signed in and end **one** device, while "sign out everywhere" keeps working exactly
as before. It exists in local mode only — OIDC sessions belong to the IdP.

It is **protocol state, not domain data** — the [[oauth-grant]] tokens and `PasswordResetToken` precedent:
ending a session hard-deletes its row, and the audit trail is a `SESSION_ENDED` row in [[user-history]].

## Fields

- `id` — `uuid()`, exposed on the wire and carried in the token as the `sid` claim ([[0005-id-strategy]]).
- `userId` — FK → [[user]], `@db.Uuid`, `onDelete: Cascade`.
- `epoch` — the user's `sessionEpoch` when the session was minted. See *Liveness* below.
- `rememberMe` — "keep me signed in" ([[0086-local-authentication-mode]] §8).
- `userAgent` — the sign-in request's `User-Agent`, truncated to 512 characters. Browser and OS are parsed
  from it **on read** by a small in-repo reader (no dependency); unknown agents read as `null`.
- `ip` — the sign-in client address as Express resolves it (`req.ip` under `trust proxy`, SEC-010), an
  IPv6-mapped IPv4 shown as plain IPv4. Informational only, never an identity.
- `createdAt`, `lastSeenAt` — `lastSeenAt` is written **at most once every 5 minutes per session**, by a
  conditional update, never per request; the value shown is approximate to that window.
- `expiresAt` — the token's `exp`; `null` for a remember-me session.

Indexes: `(userId)` (the list, sign out everywhere) and `(expiresAt)` (the sweep).

## Liveness — when a row authenticates

A token with a `sid` is accepted only when, on top of every check the guard already made (live user, same
`sessionEpoch`, active, not directory-only), its row **exists**, belongs to the token's user, carries the
token's epoch and has not expired. One primary-key read per request; no cache, so ending a session takes
effect on the next request on every replica.

A row is **listed** only while it is live: minted at the user's *current* `sessionEpoch` and not past
`expiresAt`. Every lever that bumps the epoch — sign out everywhere, password change or reset, admin reset,
deactivation, offboarding, the AD/LDAP sync's soft offboard, the recovery CLI — therefore removes the
user's sessions from the list at once, without each of those code paths knowing about this table.

## Lifecycle

- **Opened** by `POST /auth/login` (and by `POST /auth/change-password` when the caller's token predates
  this table). The id is chosen, the token is signed with it, then the row is written; if the write fails
  no token is handed out. In the same step the user's least recently active rows beyond **50** are
  deleted.
- **Kept across a password change** for the calling device: the row moves to the new epoch and expiry and
  the re-minted token keeps the same `sid` (only while it is still at the caller's epoch). Every other row
  of the user is deleted in the same transaction. The change itself is conditional on the caller's epoch:
  if a concurrent lever bumped it first, it is refused with `401 SESSION_REVOKED` and nothing is written.
- **Ended** by `DELETE /auth/sessions/:id` (one row, audited `SESSION_ENDED` with `{ sessionId, current }`),
  by `POST /auth/logout` (every row, with the epoch bump) and by a password reset (every row).
- **Purged** hourly by `UserSessionSweeper`: rows past `expiresAt`, rows whose `epoch` no longer matches
  their user's `sessionEpoch`, and remember-me rows not seen for 400 days.

## Rules

- **Self-service only.** A user lists and ends their own sessions; another user's session id is a `404`,
  indistinguishable from an unknown one. An admin ends another user's sessions through the existing levers
  (deactivate, offboard, admin password reset with *revoke sessions*), all of which bump the epoch.
- **Not full containment.** Ending a session signs that device out of the web only. For a lost or stolen
  device, changing the password is the complete answer: it also ends every OAuth connection and personal
  MCP token.
- **Not a session:** personal MCP tokens, OAuth grants and service-account tokens. They have their own
  lifecycle ([[oauth-grant]], [[service-account]]) and are neither listed here nor ended by it
  ([[0097-ai-assistant-mcp-and-headless-api]] decision 8).

## Upgrade

The table arrives empty. Tokens issued before the upgrade carry no `sid`: the guard keeps the epoch-only
check for them, so nobody is signed out by the deploy (CEO decision, 2026-09-26). They are not listed
individually; when the caller's own token is one, `GET /auth/sessions` says so with `currentIsLegacy`, and
the UI shows one synthetic "signed in before the update" entry. They end at their `exp` or on any epoch
bump — "sign out everywhere" included. Rolling the API back leaves `sid` as an unknown claim the older
verifier ignores; the table is simply unused. **Rollback caveat:** a session ended individually only lost
its row, so after a rollback to a pre-#1420 API its token works again until `exp` (never, for remember-me);
after a rollback, affected users should sign out everywhere.
