---
title: Settings
category: configuration
subcategory: instance-settings
order: 1
---

# Settings

**Settings** is the administrators-only home for configuring this lazyit instance. It is reachable
from the main navigation and is gated to the **Administrator** role — Members and Viewers do not see
it. Everything an operator tunes about the instance lives here or links out from here.

## What's in Settings

The Settings home is a grid of cards, each opening a focused sub-area:

- **Taxonomies** — manage the categories that classify assets, applications, consumables and
  knowledge-base articles, plus the asset models assets reference. See
  [Taxonomies](/help/configuration-taxonomies).
- **Locations** — the registry of places your assets physically live (offices, datacenters, racks,
  storage). It is a low-traffic registry, so it sits here under Settings rather than in the top-level
  navigation; the card links out to the full Locations page.
- **Roles** — see who holds which role across the team. This is a read-only overview; you change a
  person's role from the Users section, and you tune what each role may do under
  [Permissions](/help/permissions).
- **Service accounts** — create and manage non-human API credentials for CI, scripts and
  integrations, scoped by permission and revocable.
- **Reporting agents** — the policy every lazyit agent in this estate runs: how often hosts report,
  which collectors run, and what to leave out — plus the auto-confirm rules and the scopes that can
  override the default. This used to sit on the Instance page; the Instance page now links across to
  it. See [Reporting agent](/help/assets-topology-reporting-agent).
- **Integrations & workflows** — the cross-application manual-task inbox for provisioning workflows.
  Per-application automation is configured on each application's own Workflows tab.
- **Instance** — review how this instance is configured and manage the asset-tag scheme.

## The Instance page

The **Instance** card opens a status view of how lazyit is set up. The top card is **read-only** — it
reflects the current state; it does not change it. It shows:

- **Configured** — whether initial setup is complete (an administrator exists). A fresh install shows
  *Setup pending* until the first administrator is created.
- **Identity provider** — the sign-in posture: *Zitadel (bundled)* or *Generic OIDC (bring your
  own)*.
- **Administrators** — how many administrator accounts the instance has.
- **Runtime posture** — *Development* or *Production*.
- **Version** — the exact version this instance is running, baked in when its images were built. A
  release deploy shows the release tag (for example `v1.4.2`); a build cut between releases honestly
  shows the extended form `v1.4.2-3-gabc1234` (the nearest release plus the commit it was built
  from); a local development run shows `dev`. Quote this value in bug reports and before upgrading.

> These values are set by the environment the instance runs in, not by a form. Operators change the
> identity provider and runtime posture through environment variables at deploy time (see
> [Self-hosting](/help/deployment-operations-self-hosting)); the Instance page makes the resulting
> state discoverable in-app. Use **Refresh** to re-read it.

## Version & updates

The first card on the Instance page is **Version & updates**. It shows the version you are running and,
if you opt in, whether a newer release is available — and it gives you a *guided* way to update.

### Checking for updates (opt-in)

Update checking is **off by default**. Turn on **Check for updates weekly** and lazyit will, about once
a week, make a single anonymous request to GitHub to see whether a newer release exists. It is
**beacon-free**: no information about your instance ever leaves the host — it is the same kind of request
as checking a software mirror. If the check is blocked (a restricted-egress or air-gapped host), it
simply fails silently and the card falls back to showing your current version. "Couldn't check" is never
treated as "up to date".

When a newer release is first seen, administrators get one notification about it (and one email, if
SMTP is configured — see the SMTP card on this page). You are reminded **once per new version**, not
every week, so the reminder stays meaningful.

**Reporting agents get one line, not their own email.** Your installed reporting agents fall behind
precisely *because* the instance moved forward, so when any of them is a whole MAJOR version behind
the running instance, that same notification adds one sentence — *"12 reporting agents are a MAJOR
version behind"*. That is deliberately all it is: there is **no separate agent email, no schedule of
its own, and never one message per host**. If no agent is a MAJOR behind — or if lazyit cannot tell
what version they are running — the line simply is not there, and the notification is exactly what it
always was.

**Security releases stand out.** When a release in the gap is a security fix, the status badge turns red
(*N versions behind — security*), a distinct **Security update available** callout appears, and the email
is flagged as a security update in its subject — so a fix worth applying tonight is never lost among
routine version bumps. If a version you were already told about is *later* published as a security fix,
you get one more email so you don't miss it; after that it doesn't re-nag.

The card shows your **current version**, a status badge (*Up to date*, *N versions behind*, *Update
checks off*, *Couldn't check*, or the red *security* variant), the **latest release** with a link to its
notes, and when it was **last checked**.

### Updating (guided, not one-click)

Updating lazyit is a **guided, host-side action** — deliberately *not* a one-click in-app button. The
app never updates itself; a person runs the update on the server. This is a safety decision: anything
that could update the app in-place would need root-level control of your server, which the app is
designed never to have.

When you are behind, the card shows a single **Update to vX.Y.Z** button. Pressing it does **not**
update anything — it records the request and shows you the exact command to run on the host:

```
./infra/update.sh vX.Y.Z
```

Run that command on the server (over SSH). The script is careful and non-destructive. In order, it:

1. **Backs up both databases** (the app database and the identity database) and verifies each backup is
   restorable. **If the backup fails, the update aborts** — there is no override.
2. **Verifies the release's signature** and checks out that version.
3. **Checks for new required settings.** If the new version needs an environment variable you don't have
   yet, it **stops and tells you exactly what to add** — it never edits your secrets file for you.
4. **Builds the new version while the current one keeps serving**, then swaps to it (a brief, ~1-minute
   outage) and confirms the new version is healthy.

While an update is running, the card shows the real stage (backing up, migrating, building, restarting,
verifying) — not a fake progress bar — and quietly reconnects when the app comes back.

### Cancelling a requested update

If you pressed **Update** but haven't run the command on the host yet, the card shows a **Cancel this
update** button next to the command. Cancelling clears the pending request so the card returns to its
normal "check for updates" state and you can start a fresh update later. You can only cancel while it is
still just *requested* — once the host script has actually started (backing up and beyond), the button
is gone and that update must finish or be reconciled, because interrupting it mid-run could leave the
databases and backups out of step. The cancelled request is kept in the update history for the record.

### If an update fails — the restore point

The pre-update backup is a **restore point**, not a magic undo. If the update fails **before** the
database was migrated, the script rolls back automatically and nothing is lost. If it fails **after** a
migration ran, there is no automatic rollback: going back means **restoring the pre-update backup**,
which **discards everything written since the backup was taken** (a few minutes). The script never does
this silently — it stops and prints the exact restore commands for you to run yourself, and the previous
version, its images and the backups are kept until you confirm the new version is healthy. The full
procedure lives in the backups runbook.

## Asset-tag scheme

Below these cards, the Instance page hosts the **asset-tag scheme** editor and its backfill tool. See
[Asset tag scheme](/help/configuration-asset-tag-scheme).

## What is configured elsewhere

Not every instance-level setting is a form in Settings. Several are deliberately controlled by the
**environment** rather than the UI, because they are deployment concerns an operator owns:

- **Identity provider and runtime posture** — environment variables (surfaced read-only on the
  Instance page).
- **Display time zone** — the `NEXT_PUBLIC_DEFAULT_TIME_ZONE` variable. See
  [Time zone & formats](/help/configuration-time-zone-formats).
- **Search engine connection and reindexing** — environment plus a maintenance script. See
  [Search index](/help/configuration-search-index).

This split is on purpose: day-to-day classification and access live in the UI, while
posture-and-infrastructure settings live with the deployment so they are versioned and reproducible.
