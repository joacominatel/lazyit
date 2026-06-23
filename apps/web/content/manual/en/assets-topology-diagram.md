---
title: Infrastructure diagram
category: assets
subcategory: topology
order: 1
---

# Infrastructure diagram

The **Diagram** is a free-move map of your server estate — hosts, virtual machines, containers,
clusters, network devices, storage and more — drawn as draggable cards joined by typed
relationships. It is a generic visual inventory of *how your things relate*: which machine runs on
which host, what belongs to a cluster, what backs up to where, what depends on what.

You reach it from the sidebar under **Assets › Topology**. The same screen has a **Map ⇄ Table**
toggle in the top-right: the **Map** is this free-move board, and the **Table** is a plain,
filterable list of the same nodes — see [Servers list](/help/assets-topology-servers).

> Anyone who can view the topology sees the map and the read-only detail of each node. Adding
> nodes, drawing connections, changing a status or taking a node off the map needs the manage
> permission; without it the controls simply don't appear.

## The canvas

The board is a panning, zooming surface with a dotted background and a small minimap. Drag a node
to reposition it — the new position is saved automatically after the drag settles, so the layout
you arrange is the layout everyone sees next time. Use the controls in the corner (or your
trackpad/scroll) to zoom and fit the view.

Each node is a compact card showing:

- a **kind icon** (host, VM, container, cluster, network device, storage, appliance, or other),
- the node's **label** (its display name on the map),
- a **status pill** (see *Status* below), and
- its **IP address**, when set.

Hovering a card pops a small quick-facts tooltip (kind, status, IP). Clicking a card opens the
**details panel** on the right — the real payoff (covered below).

## Creating a node

With the manage permission you'll see an **Add node** button in the page header. The form asks for
just enough to put a thing on the map:

- **Label** — required. The name shown on the canvas (for example `pve1`, `NAS-01`, `core-switch`).
- **Kind** — required. Pick the closest generic kind. The model is deliberately platform-agnostic:
  a Kubernetes pod is a *Container*, a namespace or cloud account is a *Cluster* or *Other* — there
  are no platform-specific kinds to learn.
- **Track as asset** — a toggle, **on by default** (see below).

### Track as asset

Most things on the map are real inventory you own — a host, a NAS, a switch, a Raspberry Pi, a
long-lived VM — so by default a new node is **asset-backed**:

- Left **on**, lazyit links the node to an inventory asset. You can pick an existing asset to link,
  or leave it blank and lazyit creates a minimal one (named after the label) for you. From then on
  the node inherits everything that asset carries — its owner, its linked knowledge-base articles,
  its warranty, its shortcuts.
- Turned **off**, you get a **graph-only** node, which is the right choice for ephemeral things you
  don't inventory (a short-lived container, say). It appears on the map but has no inventory record
  behind it.

You can change your mind later. Detaching the asset from an asset-backed node leaves the node on
the map but removes the inventory link: if lazyit had auto-created the asset, that asset is
deactivated (it never lingers in inventory owned by nobody); if you had linked a pre-existing
asset, it stays untouched and is simply unlinked.

The node's **label always wins for display** on the canvas; the linked asset's name shows in the
details panel as a secondary *inventory name*, so the two never silently drift.

## Relationships (connections)

Two nodes are joined by a **typed, directional connection**. You add and manage connections from a
node's details panel (see below). The relationship kinds are:

- **Runs on** — this node is hosted or executed by another (a VM *runs on* a host). A node has
  **one active host at a time**: if you connect it to a new host, lazyit automatically closes the
  old *runs on* and opens the new one, so a machine moving between hosts leaves a clean history.
- **Member of** — this node belongs to a logical group (a host *is a member of* a cluster).
- **Depends on** — this node needs another to function.
- **Backs up to** — this node's data is backed up to another (a VM *backs up to* the NAS).
- **Connects to** — plain network adjacency. This one is **symmetric** — connecting A to B is the
  same as connecting B to A, and lazyit stores it once either way.

When you add a connection, this node is always the *source* and you pick the other node as the
target; the panel reminds you of the direction. lazyit gently warns if a pairing looks unusual (for
example a container said to *run on* a network device) but doesn't block it — the model stays
generic. If a connection would break the "one active host" rule (or duplicate an existing link),
you'll get a clear message explaining why.

## Status

Every node carries a status, shown as a colored pill on its card and badge in the panel:

- **Online** — up and reachable.
- **Offline** — down.
- **Unknown** — not established (the default for a new node).

With the manage permission you set the status from the details panel. (Status is hand-set today;
automatic liveness is a future addition.)

## Taking a node off the map

Removing a node is a **soft delete**: it comes off the map but its history is kept. Use **Remove
from map** in the details panel and confirm. Nothing is destroyed — the node (and the asset behind
it, if any) can be brought back later. lazyit never hard-deletes this data.

## The details panel

Clicking a node opens a right-hand panel — the reason this beats a static drawing. It gathers, in
one place:

- **Owner(s)** — who is responsible, pulled from the linked asset's assignments. An owner who has
  left the company but was never released is still shown, marked as such.
- **Knowledge-base articles** — published articles linked to the node's asset, each a click away.
- **Secret references** — *handles only, never the secret values themselves.* A reference shows the
  `{{ lazyit_secret.… }}` handle and a label so you know which credential goes with this machine;
  there is no reveal here and lazyit never exposes the value on this surface. (No asset-to-secret
  link exists yet, so this list is empty for now; the panel is ready for it.)
- **Shortcuts** — quick links (SSH, web UI, console) that open in a new tab.
- **IP address** and **added-on** date.
- **Children** — the nodes hosted on this one (its active *runs on* relationships).
- **Connections** — this node's active relationships (closable) and its closed history (a *runs on*
  migration shows here), plus the **Add connection** action.

A row in the [Servers list](/help/assets-topology-servers) deep-links straight into this panel, so
you can jump from the table to a machine's full picture in one click.

## Impact / blast radius

The headline question a map can answer that a drawing can't: **"if this node goes down, what is
affected?"** In the details panel, toggle **Show impact** to highlight the downstream set — every
node that runs on, or depends on, this one (directly or transitively). The canvas dims everything
outside the radius so the affected region stands out, and the panel lists each affected node with
how many hops away it is.

An **empty result is good news** — it means nothing depends on this node, so it's safe to take
down. lazyit shows that as reassurance, not as an error.

## What's next

- [Servers list](/help/assets-topology-servers) — the same estate as a filterable table.
- [Asset basics](/help/assets-asset-basics) — the inventory record behind an asset-backed node.
- [Assignments & history](/help/assets-assignments-history) — how ownership (the panel's owner) works.
