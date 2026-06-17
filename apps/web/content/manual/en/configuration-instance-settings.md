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
  [Permissions](/help/users-permissions-permissions).
- **Service accounts** — create and manage non-human API credentials for CI, scripts and
  integrations, scoped by permission and revocable.
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

> These values are set by the environment the instance runs in, not by a form. Operators change the
> identity provider and runtime posture through environment variables at deploy time (see
> [Self-hosting](/help/deployment-operations-self-hosting)); the Instance page makes the resulting
> state discoverable in-app. Use **Refresh** to re-read it.

Below the status card, the Instance page hosts the **asset-tag scheme** editor and its backfill tool —
the one configurable setting on this page. See
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
