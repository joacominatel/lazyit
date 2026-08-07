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

You reach it from the sidebar under **Assets › Topology**. The same screen has a
**Map · Table · Agents** toggle in the top-right: the **Map** is this free-move board, the **Table**
is a plain, filterable list of the same nodes — see [Servers list](/help/assets-topology-servers) —
and **Agents** is the fleet view of the machines that report themselves, with the command that
updates any of them that have fallen behind
([Reporting agent](/help/assets-topology-reporting-agent#the-agents-view)).

> Anyone who can view the topology sees the map and the read-only detail of each node. Adding nodes,
> drawing connections, changing a status or taking a node off the map needs the manage-topology
> permission; installing a reporting agent needs the manage-settings permission instead — a separate
> one, not an addition — because it mints a token. Without a permission its controls simply don't
> appear.

## Laptops and desktops are kept off the map

**If your map has got smaller, nothing has been deleted.** lazyit keeps reported **laptops and
desktops** off the diagram by default. When there are any, a button sits in the board's top-right
corner saying exactly how many — *Show 142 endpoints*. Click it and they all appear; click *Hide 142
endpoints* and they go away again. The choice is kept in the page address, so it survives a reload,
the browser Back button, and a switch to the Table and back.

**Why.** A typical estate is a couple of dozen servers and a couple of *hundred* workstations. Drawing
all of them turns the map into a wall of boxes with the infrastructure buried somewhere inside it —
and the estate topology is the thing you came here to read. Every machine still belongs in lazyit;
it just doesn't belong on this particular picture by default.

**Nothing has left your inventory.** A hidden machine is exactly as present as it was before:

- it is on the [Servers list](/help/assets-topology-servers), which **shows everything, always** —
  this hiding is the map's alone,
- it is in search, in your asset inventory and in every report,
- it still counts in a [blast radius](#impact--blast-radius): if a server goes down and a hidden
  laptop depends on it, that laptop is still in the answer,
- its own details window opens as it always did.

Hiding is a **drawing** decision about one screen, and it is the only thing it is.

**Only a machine that says it is one gets hidden.** Each reporting agent tells lazyit the host's
**form factor**, read from the machine's own firmware — *laptop*, *desktop*, *server*, *virtual
machine*, *container*. Only the first two come off the map. Anything else stays, and so does anything
that hasn't said: a node you drew by hand, a server running an older agent, a machine whose hardware
doesn't report a form factor, or one that simply hasn't checked in since you upgraded. **lazyit never
hides a machine on a guess** — a host that vanished from every screen would be far worse than a busy
map. You can see the form factor of any node on its details window's **General** tab.

**It happens gradually, not all at once.** The moment you upgrade, the map is identical: no machine
has reported a form factor yet. Each one fills it in on its next check-in, so over the following few
minutes the workstations fade off the board while the servers stay. There is nothing to run and
nothing to configure.

## The canvas

The board is a panning, zooming surface with a dotted background and a small minimap. Drag a node
to reposition it — the new position is saved automatically after the drag settles, so the layout
you arrange is the layout everyone sees next time. Use the controls in the corner (or your
trackpad/scroll) to zoom and fit the view.

The board's top-right corner is where its controls live: the **Show/Hide endpoints** button described
above (everyone sees it), and — with the manage permission — **Tidy**.

With the manage permission, a **Tidy** button sits in the board's top-right corner. Click it to
auto-arrange the whole map into a clean top-down layout — hosts above the machines that run on them,
groups above their members — whenever things get tangled after a lot of dragging and connecting. The
new positions are saved, and you can still drag any node afterwards. A new node you create lands in
the middle of your current view (and consecutive creates fan out so they don't stack), so it always
arrives where you can see it.

Each node is a compact card showing:

- a **kind icon** (host, VM, container, cluster, network device, storage, appliance, or other),
- the node's **label** (its display name on the map),
- a **status pill** (see *Status* below), and
- its **IP address**, when set.

Hovering a card pops a small quick-facts tooltip (kind, status, IP). **Clicking a card selects it**
and raises a small action bar under it with two buttons: **Show blast radius** (covered below, and it
draws its answer on the map itself) and **Details**, which opens the node's details window. A
double-click on the card opens the details window straight away. Clicking selects rather than opening
so the map stays visible — the details window is large, and covering the board on every click would
hide the thing you came to look at.

### If the map says it is incomplete

The map draws your estate in full — up to a ceiling of **2000 nodes**. Above that, a banner sits at
the top of the board and stays there:

> Showing 2000 of 2431 nodes — this map is incomplete.

It is not an error and there is nothing to retry: it means your estate has grown past what one board
can usefully draw. There is **no setting to raise the ceiling**.

What matters is what it does *not* mean. The nodes left out are **still in lazyit** — they are in your
inventory, on the [Servers list](/help/assets-topology-servers) and in search, exactly as before.
What is missing is only their picture: they are not drawn, and neither are the connections that run
through them.

That last part is the reason the banner never goes away on its own. A node that isn't drawn takes its
lines with it, so **a blast radius read off a truncated map is incomplete** — the highlighted set and
the count are the answer for the part of the estate the board is showing, not for all of it. Treat it
as a floor, not a total, and check the affected servers on the Servers list when the answer matters.

## Adding to the map

With the right permissions you'll see an **Add** button in the page header, offering two paths:

- **Install a reporting agent** — the recommended one for a server. You get a guided wizard that
  creates the credentials and hands you a ready-to-paste install command; from then on that server
  fills in its own hardware, software and status, and marks itself offline when it stops reporting.
  See [Reporting agent](/help/assets-topology-reporting-agent). This needs the manage-settings
  permission, because it mints a token.
- **Add a node by hand** — for anything that can't run an agent (a switch, a firewall, a NAS), or for
  a machine you just want on the map now. You keep a hand-drawn node up to date yourself. This needs
  the manage-topology permission.

If you only hold one of the two permissions, the button is simply that one path. If you hold neither,
there's no button — the map stays fully readable, it just isn't editable.

The **Add** button is also repeated in the middle of an empty map, since that's exactly the moment
you need it.

### Adding a node by hand

The form asks for just enough to put a thing on the map:

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
details window's header as a secondary *inventory name*, so the two never silently drift. That
inventory name is a **link back to the asset** — click it to open the asset's full record. The
asset's own detail page closes the loop the other way: it shows an **On topology** badge and a
**View in topology** button that flies the map to this node (see
[Asset basics](/help/assets-asset-basics)).

## Relationships (connections)

Two nodes are joined by a **typed, directional connection**. You add and manage connections on the
**Connections** tab of a node's details window (see below). The relationship kinds are:

- **Runs on** — this node is hosted or executed by another (a VM *runs on* a host). A node has
  **one active host at a time**: if you connect it to a new host, lazyit automatically closes the
  old *runs on* and opens the new one, so a machine moving between hosts leaves a clean history.
- **Member of** — this node belongs to a logical group (a host *is a member of* a cluster).
- **Depends on** — this node needs another to function.
- **Backs up to** — this node's data is backed up to another (a VM *backs up to* the NAS).
- **Connects to** — plain network adjacency. This one is **symmetric** — connecting A to B is the
  same as connecting B to A, and lazyit stores it once either way.

When you add a connection, this node is always the *source* and you pick the other node as the
target; the form reminds you of the direction. lazyit gently warns if a pairing looks unusual (for
example a container said to *run on* a network device) but doesn't block it — the model stays
generic. If a connection would break the "one active host" rule (or duplicate an existing link),
you'll get a clear message explaining why.

### Reading the lines

On the map each relationship kind is drawn so you can tell them apart at a glance — not by colour
alone, but by **colour, line style and arrowhead** together: *runs on* and *member of* are solid
(member-of a touch heavier, the grouping backbone), *depends on* is dashed with a gently flowing
animation pointing the way the dependency runs, *backs up to* is dotted, and the symmetric *connects
to* is a thin plain line with no arrow. Hovering or selecting a line shows a small label naming the
relationship. A collapsible **edge legend** in the bottom-left corner maps every kind to its colour
and style — open it whenever you need a reminder. Hovering a node also **spotlights** it: the rest of
the map dims so you can see at a glance what that node is connected to.

## Status

Every node carries a status, shown as a colored pill on its card and as a badge in the details
window's header:

- **Online** — up and reachable.
- **Offline** — down.
- **Unknown** — not established (the default for a new node).

With the manage permission you set the status on the details window's **General** tab. Nodes
reported by the [reporting agent](/help/assets-topology-reporting-agent) carry their status (and an
*Agent-reported* badge with a "reported … ago" freshness) automatically; you can still set it by hand
for nodes you manage yourself.

> **Auto-discovered nodes.** Servers reported by the [reporting agent](/help/assets-topology-reporting-agent)
> don't appear on the map straight away — they wait in the **Pending review** tray on the
> [Servers list](/help/assets-topology-servers) until you confirm them.

## Taking a node off the map

Removing a node is a **soft delete**: it comes off the map but its history is kept. Use **Remove
from map** at the bottom of the details window's **General** tab and confirm. Nothing is destroyed —
the node (and the asset behind it, if any) can be brought back later. lazyit never hard-deletes this
data.

## The details window

Select a node and click **Details** (or double-click the node) to open its details window — the
reason this beats a static drawing. It's a large window with tabs, because a machine reported by an
agent carries far more than a hand-drawn card ever did, and putting it all in one column meant
scrolling past everything to reach one thing.

**The tabs adapt to the node.** You only ever see the ones that have something to say:

- **General** *(always)* — what this node is and who is responsible for it: kind, IP address,
  **form factor** (for agent-reported hosts — what decides whether it's drawn on the map by default),
  added-on date, status, owner(s), knowledge-base articles, secret references and shortcuts, plus
  **Remove from map**.
- **Reported facts** *(agent-reported nodes only)* — what the machine says it is made of. For a
  server: operating system, kernel, CPU, memory, manufacturer/model/serial, and the disks and network
  interfaces it found. For a container: its name, image, image digest, runtime state, container id
  and its published ports, in a table with room to read it.
- **Software** *(reporting servers only)* — the installed-package list, searchable, with its own room.
  Containers don't report one, so they don't get this tab; neither does a server lazyit holds no list
  for — see [Reporting agent](/help/assets-topology-reporting-agent) for the difference between "no
  list" and "an empty one".
- **Connections** *(always)* — what this node is wired to: **Runs here** (the nodes hosted on it) and
  its active relationships (closable) plus its closed history, with the **Add connection** action.
- **Changes** *(always)* — what has moved on this node over time. See
  [Reporting agent](/help/assets-topology-reporting-agent).

> **Editing in place.** With the manage permission the **General** tab's **Details** block is
> editable — no separate page. Click the **title** in the window's header to rename the node; change
> its **kind**, **IP address** or **status** right there; and the **shortcuts** are editable too.
> Edits save as you go and the node's card on the canvas updates immediately. Read-only viewers see
> the same facts as plain text, with no edit controls. The **IP address** is checked when you save
> it: it must be a valid IPv4 or IPv6 address, and an invalid entry is rejected with a clear message
> rather than saved.

A few things on the **General** tab worth calling out:

- **Owner(s)** — pulled from the linked asset's assignments. An owner who has left the company but
  was never released is still shown, marked as such.
- **Secret references** — *this surface stores handles only, never the secret values themselves.* A
  reference shows a label and a **reveal (eye)** control. If you're a member of the secret's vault you
  can reveal the value right here — the same as a KB secret chip: click the eye, unlock if prompted,
  and the value is decrypted **in your browser** (lazyit's servers never see it) and auto-hides after
  a few seconds. If you're **not** a member you see a locked chip and nothing is exposed. With the manage
  permission you attach a reference from the **Attach a secret** picker — it lists only the secrets
  **you can access** (the vaults you're a member of) and you choose one by its handle; the **×** next
  to a reference detaches it. References are stored by handle and resolved live, so the label always
  reflects the current secret — and if the secret is removed (or its handle changed) the reference
  simply drops from the list.
- **Shortcuts** — quick links (SSH, web UI, console) that open in a new tab. With the manage
  permission you edit them inline: each shortcut is a label + URL pair you can change, add or remove,
  then **Save** the list (lazyit checks each URL is valid before saving).
- **Form factor** — for a node reported by an agent, what the machine says it physically is, read
  from its firmware: *laptop*, *desktop*, *server*, *virtual machine* or *container*. It's shown, not
  editable — the agent rewrites it on every check-in, so a machine that's re-imaged or gets a new
  board keeps it honest by itself. It's also what decides whether the node is drawn on the map by
  default (see *Laptops and desktops are kept off the map* above). A hand-drawn node has none, and a
  machine that hasn't reported one simply doesn't show this field.
- **Duplicate IP** — if another node on the map already carries the *exact same* IP, a **non-blocking
  warning** lists the other node(s) — a heads-up, not a block: the address is still saved (lazyit
  enforces no uniqueness on IPs), and each listed node is a click away so you can jump over and
  reconcile.
- **Possible duplicate in inventory** — a second non-blocking warning, for machines that were recorded
  twice by older versions of lazyit. If this node's asset was created automatically and has no serial
  number, while the serial the machine reports belongs to a *different* asset, lazyit says so and
  links the other asset so you can go and look. **It is a heads-up and nothing else: lazyit never
  merges the two for you.** Combining two inventory records means deciding what happens to two sets of
  assignments, history, tags and attached documents, and that's a judgement call, not something an
  upgrade should make while you're not watching. See
  [Reporting agent](/help/assets-topology-reporting-agent) for how this situation came about and what
  stops it happening again.

A row in the [Servers list](/help/assets-topology-servers) deep-links straight into this window, so
you can jump from the table to a machine's full picture in one click.

## Impact / blast radius

The headline question a map can answer that a drawing can't: **"if this node goes down, what is
affected?"** Select the node and click **Show blast radius** on its action bar — the control lives on
the map, because the answer is drawn on the map. Every node that runs on, depends on, or is a member
of this one (directly or transitively) lights up; taking down a cluster or group therefore surfaces
its members. The canvas dims everything outside the radius so the affected region stands out, and
hovering any highlighted node shows how many hops away it is.

A small banner at the bottom carries the rest of the answer: **how many** nodes are affected, and
**which ones** — the affected nodes are listed under the count, each with its kind and how many hops
away it is, closest first. The list is open by default and scrolls inside itself; the chevron beside
the count folds it away when you'd rather see the whole board, and **Hide blast radius** turns the
whole thing off. The highlight tells you roughly how bad it is at a glance; the list is what you
scan, count or copy. While the radius is still being worked out the banner says so, and if the query
fails it says that too, with a **Retry** — a failed query is never shown as "nothing depends on this
node".

Impact is an **edge-derived estimate**, not a hand-verified guarantee — it follows the edges you've
drawn, so a member might survive a group losing one node. Backup-target and network-only links are
deliberately ignored: a backup target failing doesn't take down the primary, and a plain network
connection has no failure direction.

An **empty result is good news** — it means nothing depends on this node, so it's safe to take
down. lazyit shows that as reassurance, not as an error.

> [!IMPORTANT]
> If the board is showing the *"this map is incomplete"* banner, the blast radius is answered over
> what is drawn, so it can be smaller than the truth. See
> [If the map says it is incomplete](#if-the-map-says-it-is-incomplete).

## What's next

- [Servers list](/help/assets-topology-servers) — the same estate as a filterable table.
- [Reporting agent](/help/assets-topology-reporting-agent) — auto-populate the map from your servers.
- [Asset basics](/help/assets-asset-basics) — the inventory record behind an asset-backed node.
- [Assignments & history](/help/assets-assignments-history) — how ownership (the General tab's owner) works.
