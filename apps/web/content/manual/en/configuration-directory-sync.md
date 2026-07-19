---
title: AD / LDAP directory sync
category: configuration
subcategory: directory-sync
order: 5
---

# AD / LDAP directory sync

lazyit can **import people from your on-prem Active Directory (or any LDAP directory)** so you don't have
to type your team into lazyit by hand. You point lazyit at your directory under **Settings → Instance →
AD / LDAP directory sync** (administrators only). It is **off until you turn it on**.

## What it does — and what it deliberately does not

The directory sync is **read-only and one-way**. lazyit connects to your directory with a read-only service
account, searches a subtree you choose, and **creates a login-less "directory person"** in lazyit for each
matching entry. That is the whole feature.

- It **never writes anything back** to your directory. lazyit only reads.
- It is **not a way to log in.** A directory person has **no password and no single sign-on** — importing
  someone does not let them sign in. It is a record of a person (a name and email you can assign assets to,
  grant access for, and track), not an account. To give an imported person a real login, use **Provision
  account** on their profile in the **Users** section.
- It **does not change how permissions work.** Everyone imported is a plain viewer-level person. Directory
  groups (`memberOf`) are recorded for reference only and grant nothing.

Directory people are ordinary users in lazyit, mixed into the **Users** list and marked with a **Directory**
badge — the same kind of login-less person the bulk import creates.

## Configuring the connection

The editor has these fields:

- **Enable scheduled sync** — the master switch for the **automatic, periodic** import. While it is off,
  lazyit only imports when you press **Sync now** (see below).
- **Directory host** and **Port** — your directory server's address (for example `dc01.corp.example.com`,
  port `636`).
- **Transport security** — how the connection is protected:
  - **LDAPS** (recommended, usually port `636`) — encrypted from the first byte.
  - **StartTLS** (usually port `389`) — connect in plaintext, then upgrade to TLS.
  - **Plaintext** (port `389`) — no encryption. The bind password travels in the clear, so use it only on a
    trusted internal segment.
- **Verify TLS certificate** — on by default (secure). Turn it off only if your server uses a self-signed
  certificate you trust. It does not apply to a plaintext connection.
- **Search base (base DN)** — the subtree lazyit searches, for example
  `OU=People,DC=corp,DC=example,DC=com`.
- **Bind DN** — the read-only service account lazyit connects as, for example
  `CN=svc-lazyit,OU=Service,DC=corp,DC=example,DC=com`. This identifies the credential; it is not the secret
  itself.
- **Bind password** — the service account's password. It is **write-only**: once saved, lazyit shows only
  that a password is **configured** and never displays it again. Leave the field blank when editing to
  **keep** the stored password; type a new value only to change it.
- **Search filter** — the LDAP filter that selects which entries to import, for example
  `(&(objectClass=user)(objectCategory=person))`. It is run **verbatim** — lazyit never substitutes anything
  into it per user.
- **Offboard grace (days)** — how many days a person may be **missing from the directory** before lazyit
  **deactivates** them (see below). `0` deactivates on the first sync that no longer finds them.
- **Attribute mapping** — which directory attribute fills each lazyit field. Type the directory attribute
  name next to each lazyit field (typical Active Directory names are `givenName`, `sn`, `mail`,
  `sAMAccountName`). Leave a field blank to skip it.

> The bind password is stored **encrypted at rest**. Saving a password requires the server key
> `DIRECTORY_SECRET_KEY` to be set; if it isn't, lazyit saves the rest of the settings and tells you to set
> the key first. See your deployment's environment configuration.

## Running a sync and reading the result

Use **Sync now** to import immediately using the **currently saved** settings — so **save first**, then
sync. Sync now works even while the scheduled sync is off, so it doubles as a **connection test**: if the
bind or search fails, lazyit shows a short, non-secret error (for example "bind failed" or "host
unreachable").

After each run — manual or scheduled — the panel shows the **last run's status and time** and a count of
what happened:

- **Created** — new directory people added.
- **Updated** — existing people whose mapped fields were refreshed.
- **Offboarded** — people **deactivated** because they had been missing from the directory past the grace
  window. This is a **soft deactivation** (they become inactive, keeping their history), never a hard delete.
- **Skipped** — entries left untouched (for example an entry that can't be identified, or one whose email
  collides with a real login account).

## Reviewing imported people

Below the editor, **Directory people to review** previews the most recently imported people. Each one links
to their profile, where you can edit them, **provision a login**, or offboard them. Use **View all in
Users** to open the full, searchable list filtered to directory people.

## Upgrading an existing instance

Directory sync is **off by default** and adds nothing until an administrator configures it, so upgrading an
existing lazyit instance changes nothing on its own. Turn it on only after you have set the
`DIRECTORY_SECRET_KEY` server key and filled in the connection.
