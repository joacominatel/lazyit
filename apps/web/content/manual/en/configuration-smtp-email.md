---
title: Email & SMTP
category: configuration
subcategory: smtp-email
order: 4
---

# Email & SMTP

lazyit can send **outbound email** so a curated set of its notifications also lands in your team's inbox,
not just the in-app **notification bell**. You point lazyit at your existing mail relay (SMTP) under
**Settings → Instance → SMTP** (administrators only). It is **off until you turn it on**.

## Configuring the connection

The SMTP editor has these fields:

- **Enabled** — the master switch for outbound email. While it is off, lazyit never sends notification
  emails (you can still send a test — see below).
- **Host** and **Port** — your mail relay's address (e.g. `smtp.example.com`, port `587`).
- **Security** — how the connection is protected:
  - **STARTTLS** (recommended, usually port `587`) — connect in plaintext, then upgrade to TLS.
  - **Implicit TLS** (usually port `465`) — encrypted from the first byte.
  - **None** — plaintext, no encryption. Only for a trusted internal relay.
- **Username** — the SMTP login. Leave it blank for an open/unauthenticated relay on a trusted network.
- **Password** — the SMTP password. It is **write-only**: once saved, lazyit shows only that a password
  is **configured** and never displays it again. Leave the field blank when editing to **keep** the
  stored password; type a new value only to change it.
- **From address** and **From name** — the address (and optional display name) your emails are sent from.
- **Reject unauthorized TLS certificates** — on by default (secure). Turn it off only if your relay uses a
  self-signed certificate you trust.

> The password is stored **encrypted at rest**. Saving a password requires the server key
> `SMTP_SECRET_KEY` to be set; if it isn't, lazyit saves the rest of the settings and tells you to set the
> key first. See your deployment's environment configuration.

## Sending a test email

Use **Send test email** to confirm everything works before you rely on it. Enter a destination address
and lazyit sends a real message using the **currently saved** settings — so **save first**, then test.
You do **not** need to enable outbound email to test. If the relay rejects the message, lazyit shows a
short error (for example "connection refused" or "authentication failed") instead of failing silently.

## Which notifications are emailed

When outbound email is on, lazyit emails a small, curated set of **operational** notifications — the same
ones that appear in the bell:

- **Low stock** — a consumable dropped to or below its minimum.
- **A workflow needs a human** and **a workflow run failed**.
- **Access to a critical application was granted**, and **a user was raised to administrator**.
- **A sensitive permission change** and **a reporting agent going offline** (the sensitive-audit alerts).

Each email goes to the **same people who see that notification in the bell**: a broadcast goes to your
administrators; a notification addressed to one person goes to that person. Broadcast emails use **Bcc**
so recipients don't see each other's addresses. The vault-setup sign-in nudge stays **bell-only**.

> Email is **best-effort**: if your relay is down or misconfigured, the in-app notification still appears
> and nothing else breaks — the email is simply retried a few times and then dropped. Email is a
> convenience channel, not the system of record.
