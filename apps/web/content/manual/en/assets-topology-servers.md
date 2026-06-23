---
title: Servers list
category: assets
subcategory: topology
order: 2
---

# Servers list

The **Servers** view is the scannable, table form of your topology — the same nodes as the
[Diagram](/help/assets-topology-diagram), but as a plain list you can search and filter instead of
a free-move map. You reach it from the sidebar under **Assets › Servers**.

It's handy when you want to *find* a machine rather than *see* how it connects: scan a column,
filter to one kind, or search by name.

> The list shows the same things to everyone who can view the topology. It is read-only here —
> creating, editing and connecting nodes all happen on the [Diagram](/help/assets-topology-diagram).

## Columns

Each row is one node:

- **Label** — the node's display name; click it to open its details.
- **Kind** — host, VM, container, cluster, and so on.
- **Status** — Online, Offline or Unknown, as a colored badge.
- **Asset** — whether the node is **Tracked** (asset-backed) or **Graph-only**. This column shows
  the *link*, not the asset's name: the linked asset's full name and owners live one click away in
  the details panel.
- **IP** — the node's primary IP address, when set.

## Searching and filtering

- **Search** matches the **label** and **IP** as you type.
- **Kind**, **Status** and **State** dropdowns narrow the list. *State* distinguishes confirmed
  nodes from any pending ones (pending nodes are part of a future auto-discovery feature; today
  everything is confirmed).

Active filters appear as removable chips below the toolbar, and a **Clear** action resets them all.

## Opening a server

Clicking a row opens it in the Diagram's details panel — the full picture: owner, linked
knowledge-base articles, secret references (handles only), shortcuts, connections and the
impact/blast-radius toggle. See [Infrastructure diagram](/help/assets-topology-diagram) for what
the panel covers.

## What's next

- [Infrastructure diagram](/help/assets-topology-diagram) — the same estate as a free-move map.
- [Asset basics](/help/assets-asset-basics) — the inventory record behind an asset-backed node.
