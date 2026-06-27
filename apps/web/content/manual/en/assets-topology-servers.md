---
title: Servers list (Table view)
category: assets
subcategory: topology
order: 2
---

# Servers list (Table view)

The **Table** view is the scannable, table form of your topology — the same nodes as the
[Map](/help/assets-topology-diagram), but as a plain list you can search and filter instead of a
free-move map. It is not a separate sidebar entry: you reach it from **Assets › Topology**, then flip
the **Map ⇄ Table** toggle in the top-right (next to **Add node**). The Table is also available
directly at `/assets/diagram?view=table`.

It's handy when you want to *find* a machine rather than *see* how it connects: scan a column, filter
to one kind, or search by name.

> The list shows the same things to everyone who can view the topology. Creating, editing and
> connecting nodes all happen on the [Map](/help/assets-topology-diagram); the Servers view adds two
> things of its own — the **Pending review** tray and the **Add a server** button (both below).

## Switching between Map and Table

The **Map ⇄ Table** toggle lives in the Topology header. Switching views keeps your context: the
table's search and filters (Kind, Status, State) and any node you have selected all carry across, so
flipping to the Map shows the same estate — and clicking a row in the Table opens that node straight
on the Map.

## Columns

Each row is one node:

- **Name** — the node's display name; click it to open its details on the Map.
- **Kind** — host, VM, container, cluster, and so on.
- **Status** — Online, Offline or Unknown, as a colored badge.
- **Asset** — the linked inventory asset's name when the node is asset-backed, or **Graph-only**
  when it isn't. (A name is hidden if the linked asset was archived.)
- **Owner** — the asset's current owner(s). With more than one, the first is shown plus a "+N more"
  hint; the full list is in the details panel. Someone who has left the company shows struck-through.
- **IP** — the node's primary IP address, when set.

## Searching and filtering

- **Search** matches the **name**, **IP**, the linked **asset name** and the **owner** as you type.
- **Kind**, **Status** and **State** dropdowns narrow the list. *State* distinguishes **confirmed**
  nodes from **pending** ones — pending nodes are servers the
  [reporting agent](/help/assets-topology-reporting-agent) discovered and that are awaiting your
  approval (see *Pending review* below).

Active filters appear as removable chips below the toolbar, and a **Clear** action resets them all.

## Pending review

When the [reporting agent](/help/assets-topology-reporting-agent) discovers a server, it doesn't go
straight into your inventory — it lands in the **Pending review** tray at the top of this view (shown
only to people who can manage the topology). Each pending server shows its hostname, kind, where the
report came from and how fresh it is, with two actions: **Confirm** to add it to your live topology
(optionally also creating a tracked asset), or **Discard** to drop the proposal. See
[Reporting agent](/help/assets-topology-reporting-agent) for the full flow.

## Add a server

The **Add a server** button (top of this view, for people who can manage settings) generates the
one-time install command for the reporting agent so a new Linux server can start reporting itself.
See [Reporting agent](/help/assets-topology-reporting-agent).

## Opening a server

Clicking a row switches to the Map and opens the node in its details panel — the full picture: owner,
linked knowledge-base articles, secret references (handles only), shortcuts, connections and the
impact/blast-radius toggle. See [Infrastructure diagram](/help/assets-topology-diagram) for what the
panel covers.

## What's next

- [Infrastructure diagram](/help/assets-topology-diagram) — the same estate as a free-move map.
- [Reporting agent](/help/assets-topology-reporting-agent) — auto-discover servers into the tray above.
- [Asset basics](/help/assets-asset-basics) — the inventory record behind an asset-backed node.
