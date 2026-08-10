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
the **Map · Table · Agents** toggle in the top-right (next to **Add**). The Table is also available
directly at `/assets/diagram?view=table`.

It's handy when you want to *find* a machine rather than *see* how it connects: scan a column, filter
to one kind, or search by name.

> The list shows the same things to everyone who can view the topology. Creating, editing and
> connecting nodes all happen on the [Map](/help/assets-topology-diagram); the Servers view adds two
> things of its own — the **Pending review** tray and the **Add a server** button (both below).

## Switching between Map, Table and Agents

The **Map · Table · Agents** toggle lives in the Topology header. Switching views keeps your context:
the table's search and filters (Kind, Status, State) and any node you have selected all carry across,
so flipping to the Map shows the same estate — and clicking a row in the Table opens that node
straight on the Map.

The third view, **Agents**, is about the machines that report themselves rather than about the graph:
which agent versions you are running, who has stopped checking in, and the command that updates a
host that has fallen behind. See
[the Agents view](/help/assets-topology-reporting-agent#the-agents-view).

## Columns

Each row is one node. **Click a column header to sort by it** — Name, Kind, Status and IP are
sortable, and clicking the same header again flips between ascending and descending. The sort is done
by lazyit across your **whole** estate, not just the rows on the current page, so sorting by Name and
going to the last page really does land you on the last name alphabetically.

- **Name** — the node's display name; click it to open its details on the Map. Sortable.
- **Kind** — host, VM, container, cluster, and so on. Sortable.
- **Status** — Online, Offline or Unknown, as a colored badge. Sortable.
- **Asset** — the linked inventory asset's name when the node is asset-backed, or **Graph-only**
  when it isn't. (A name is hidden if the linked asset was archived.)
- **Owner** — the asset's current owner(s). With more than one, the first is shown plus a "+N more"
  hint; the full list is in the details window. Someone who has left the company shows struck-through.
- **IP** — the node's primary IP address, when set. Sortable.

**Asset and Owner are not sortable**, and that is deliberate: neither belongs to the server itself.
Both are read from the *linked inventory asset* — one of them through its current assignment — so
there is no column on the server to order by. Sort by Name to group them predictably instead.

## Searching and filtering

- **Search** matches the **name**, **IP**, the linked **asset name** and the **owner** (name or
  email) as you type. The search runs across your **whole estate**, not just the page you are looking
  at — so a machine on page four is found from page one, and "no results" genuinely means no results.
- **Kind**, **Status** and **State** dropdowns narrow the list. *State* distinguishes **confirmed**
  nodes from **pending** ones — pending nodes are servers the
  [reporting agent](/help/assets-topology-reporting-agent) discovered and that are awaiting your
  approval (see *Pending review* below).

Active filters appear as removable chips below the toolbar, and a **Clear** action resets them all.

## Paging through the list

The table shows a page at a time, with the **page controls at the bottom**: how many rows you are
looking at, out of how many match, and the buttons to step between pages.

That count is the count of what your **search and filters** asked for, not of your whole estate — so
with a Kind filter on, "1–50 of 118" means 118 nodes of that kind, and stepping through the pages
walks all 118. Search, filters and sort are all applied by lazyit before the page is cut, so changing
any of them re-cuts the pages and returns you to the first one. Your page, search, filters and sort
all live in the URL, so the view survives a reload and can be shared or bookmarked as-is.

> [!NOTE]
> The list used to load every node at once and search them in your browser. It doesn't any more — an
> estate can now grow fast (a single hypervisor can enrol hundreds of virtual machines from one
> report, see [Hypervisor hosts](/help/assets-topology-hypervisors)), and a search that only
> covered what happened to be loaded would quietly miss machines.

## Pending review

When the [reporting agent](/help/assets-topology-reporting-agent) discovers a server, it doesn't go
straight into your inventory — it lands in the **Pending review** tray at the top of this view (shown
only to people who can manage the topology). Each pending server shows its hostname, kind, where the
report came from and how fresh it is, with two actions: **Confirm** to add it to your live topology
(optionally also creating a tracked asset), or **Discard** to drop the proposal. See
[Reporting agent](/help/assets-topology-reporting-agent) for the full flow.

The number beside **Pending review** is the **whole queue**, and the tray works through it **200 at a
time**, most recently discovered first. When there are more than that, it tells you so above the rows
— *"Showing 200 of 431 pending nodes"* — and confirming or discarding the batch reveals the next one.
The tray is empty only when the queue is.

## Add a server

Use **Add › Install a reporting agent** in the page header (visible to people who can manage
settings, in either view) to generate the one-time install command for the reporting agent — for a
**Linux or a Windows** host, whichever you pick — so a new server can start reporting itself. Until
you have your first agent, this view also leads with a **Create your first agent** card explaining
what one is. See [Reporting agent](/help/assets-topology-reporting-agent).

## Opening a server

Clicking a row switches to the Map and opens the node's details window — the full picture: owner,
linked knowledge-base articles, secret references (handles only), shortcuts, connections, the
reported hardware and software, and the change history. See
[Infrastructure diagram](/help/assets-topology-diagram) for what each tab covers. The
impact/blast-radius toggle is on the map itself, on the selected node's action bar.

## What's next

- [Infrastructure diagram](/help/assets-topology-diagram) — the same estate as a free-move map.
- [Reporting agent](/help/assets-topology-reporting-agent) — auto-discover servers into the tray above.
- [Asset basics](/help/assets-asset-basics) — the inventory record behind an asset-backed node.
