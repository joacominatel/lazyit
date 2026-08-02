---
title: Reporting agent
category: assets
subcategory: topology
order: 3
---

# Reporting agent

The **reporting agent** populates your inventory for you. It's a small program you drop onto a Linux
server with a single command; from then on the server reports *what it is* — its hardware and the
software installed on it — back to lazyit and keeps that picture current, so you don't have to enter
or maintain it by hand.

It is deliberately narrow. The agent is **inventory-only**: it reports what a host is and what it
runs, never metrics, alerts or time-series data. lazyit is a CMDB, not a monitoring tool. The agent
discovers **only the host it runs on** — there is no network scanning. To cover more servers, you
install it on more servers.

> The agent only ever **adds proposals**. A newly discovered host arrives in the **Pending review**
> tray as a proposal — it never changes your live inventory until a human confirms it.

## Create your first agent

On the **Servers** view (the Table view of **Assets › Topology**), when you have no agents yet, a
**Create your first agent** card sits at the top. Once you have agents, it collapses to a quiet
**Add agent** button. (You need the manage-settings permission to use it, because it mints a token.)

The button opens a short, guided wizard with three steps:

1. **Name & generate.** Give the agent a name you'll recognise later (for example the server's name,
   like `web-prod-01`) and click **Generate credentials**. lazyit creates a service account scoped to
   **only** the `infra:report` permission.
2. **Install.** lazyit shows a ready-to-paste **install command** with the token already filled in:

   ```sh
   curl -fsSL https://your-instance/install.sh | sudo sh -s -- --url https://your-instance --token <token>
   ```

   The address is **your own lazyit instance** — the agent only ever talks to the server you run, and
   it must be the **public HTTPS origin** (the address you use in a browser, in front of the reverse
   proxy) — **never** the raw web port (`:3000`), which has no route for the agent download and will
   make the install fail. Run it on a **Linux** server **as root**. The token is shown **only once**,
   so copy it (or download it) before continuing. If you'd rather inspect every step, expand **Install
   manually (step by step)** for the same install done by hand (download the binary, install it, write
   the config file, send a test report).

   > **Keep the token out of the shell.** As written above, the token is visible in `ps` to every
   > user on that machine for the few seconds the install runs, and it lands in root's shell history.
   > If that matters where you work, two equivalent forms avoid it: put the token in the environment
   > (`LAZYIT_TOKEN=… sh install.sh --url …`), or in a file and pass `--token-file /root/agent.token`.
   > Download the script first for either. (`--token-file -` reads it from a pipe, which is why it
   > can't be combined with `curl … | sh` — the pipe is already the script's input.)

   > **LAN deployment (no public domain)?** If your instance is reachable only by a LAN IP or hostname
   > with a self-signed certificate, copy that certificate authority's `.pem` onto the agent host and
   > pass **`--ca-file /path/to/ca.pem`**. The installer uses it for its own download *and* records it
   > so the agent uses it on every report — you do **not** need to trust that authority system-wide,
   > which would have been a much larger change to the machine than "one inventory agent talks to one
   > server". Trusting it system-wide still works if that's already how your fleet is built.

   > **Behind an egress proxy?** Pass nothing at install time; add `HTTPS_PROXY` (and `NO_PROXY` if
   > your instance is internal) to `/etc/lazyit-agent/config` afterwards. It has to go **there**, not
   > in `/etc/environment` or a shell profile: the agent runs from a systemd timer, and a timer does
   > not inherit the machine's login environment — which is why an agent can work when you run it by
   > hand and stay silent on its own schedule. Lowercase (`https_proxy`, `no_proxy`) works too, and
   > wins if you write both, the same way `curl` reads them. What you put in that file is the agent's
   > **whole** answer: a `NO_PROXY` there does stop a proxy the machine set elsewhere, rather than
   > losing to it. Re-running the installer keeps these lines, in either spelling.
3. **Wait.** The wizard then waits for the server to report. As soon as the agent checks in — usually
   within a couple of minutes — it shows a success message and an inline **Confirm** button. You can
   confirm right there, or close the wizard and confirm later from the Pending review tray.

### Install manually (step by step)

The wizard's collapsed **Install manually** section gives the same install command-by-command, for a
cautious admin who prefers to download and inspect the binary first. Each step has its own copy
button:

1. **Download the binary** (use `arch=arm64` on ARM machines):

   ```sh
   curl -fsSL -H "Authorization: Bearer <token>" "https://your-instance/api/agent/download?arch=x64" -o lazyit-agent
   ```
2. **Make it executable and move it into place:**

   ```sh
   chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/
   ```
3. **Create the config file** (it holds the token, so `chmod 600`) with `LAZYIT_URL` and
   `LAZYIT_TOKEN` at `/etc/lazyit-agent/config`.
4. **Send a first report** to check it works:

   ```sh
   sudo lazyit-agent report --once --force
   ```

### What a host needs to run it

A **Linux** machine with **systemd** and **curl**, on x86-64 or ARM64. The agent is a single
self-contained binary — no runtime, no packages, nothing to install alongside it.

There is a floor on how old the machine's system libraries and kernel can be, and rather than print
a version number that would go stale, **the installer tries running the binary before it sets
anything up**. If the machine can't start it, you get one clear sentence, nothing is installed and no
timer is armed — instead of a host that looks fine and silently never reports.

On x86-64 there are two builds and the installer picks between them by reading the CPU's own feature
list: the ordinary one needs a 2013-or-later instruction set, and older machines — or VMware clusters
configured to present an older CPU to their guests — get a **baseline** build automatically. This
matters more than it sounds: a virtual machine can run happily for months and then start crashing the
moment it migrates onto older hardware. `--baseline` forces it if you'd rather not depend on the
detection.

### Check a host without waiting for a report

Two commands answer the two questions you'll actually have, and **neither sends or changes
anything**:

```sh
sudo lazyit-agent test    # can this host reach lazyit, and is its token good?
sudo lazyit-agent show    # what exactly would this host report?
```

**`test`** checks the address, DNS, TLS, the proxy, the certificate authority and the token, and
tells you which one is wrong — a redirect means you pointed it at the wrong port, a rejection means
the token, a timeout means the network, and an address that answers but isn't lazyit is named as
exactly that rather than passing. (It asks twice on purpose: once without your token, to confirm the
address really is a lazyit instance that demands one, and once with it. Both are reads.) It also
prints how often this host is set to report, when it
last succeeded and whether the next tick would report at all, which is usually the answer to "this
server has gone quiet". It writes nothing on the host and nothing in lazyit: no proposal appears, no
server is marked as having just reported, and nothing is counted against the token's report limit.

**`show`** prints the full report as JSON, without sending it. This is the fastest way to answer
"why is this host's serial column empty" or "why isn't this disk listed" — the notes at the end say
what the agent had to skip and why. It works on a machine with no token and no network at all.

## Removing the agent

Re-run the install script with `--uninstall`:

```sh
sudo sh install.sh --uninstall
```

It stops and disables the timer, then removes the binary, both systemd units, the agent's local state
and its configuration file — including **the token**, which is destroyed whichever options you use.
It's safe to run twice, and safe on a half-finished install.

If you're re-imaging a machine that will get the agent back, add **`--keep-config`**: it keeps that
host's own limits and its proxy settings (the things the machine's owner chose, which are annoying to
reconstruct) and still strips the token and the instance address. There is no option that leaves the
token behind — a working credential for your instance should not survive on a machine you just
decommissioned.

Two things uninstalling does **not** do, deliberately. The server's entry in lazyit stays exactly as
it is: discard it from the Servers view if you want it off the map. And the token is only removed
*from that host* — if no other machine uses it, revoke the service account in
[Service accounts](/help/users-permissions-service-accounts).

## Pending review

Discovered hosts don't go straight into your inventory — they wait for you in the **Pending review**
tray at the top of the Servers view, each showing its hostname, kind, where the report came from and
how long ago it last reported. For each one you have three choices:

- **Confirm** — adds the host to your live topology. A short dialog lets you rename it and change its
  kind first, and offers a **Track as an inventory asset** toggle (**on** by default): left on,
  lazyit also creates a tracked **asset** carrying the reported host facts, so the server can have an
  owner, knowledge-base links and secret references like any other asset. If the host reported a real
  hardware **serial number**, it becomes that asset's serial automatically (a placeholder like
  *"To be filled by O.E.M."*, or a serial already used by another asset, is skipped). Turn the toggle
  off to keep the node graph-only.
- **Merge into…** — this host is one you already have. Pick the existing server it really is, and its
  reporting key moves there: future check-ins land on that server, and this proposal is archived. Use
  it when a machine was **reinstalled** (a fresh OS gives it a new machine ID, so it comes back looking
  like a stranger while the server you already curated goes quiet), or when lazyit separated out a
  cloned host (below). The server you pick keeps what you set on it — its name, kind, position, owner,
  asset link and connections, and an IP you typed by hand stays yours. What moves is the reporting key
  and the reported facts that come with it, so an IP the *agent* filled in is replaced by the incoming
  host's. **If the server you pick already reports through an agent of its own, that reporting key is
  replaced** — which is exactly what you want after a reinstall, but it means a host still checking in
  with the old key comes back as a new pending server. The archived row records both keys — the one it
  handed over and the one that was replaced — and it no longer holds a reporting key itself, so
  restoring it would bring back the entry and your edits, never the reporting key. If the two report the same
  hardware serial or network-card address, the dialog says so at the top (*"this looks like
  srv-app-04"*); that only appears when both were reported by an agent recent enough to send those
  details, and it is a suggestion you confirm, never a choice made for you.
- **Discard** — removes the proposal. This is a soft delete (the same as removing any node from the
  map): nothing is destroyed and it can be restored later. **Discarding does not stop the agent.** If
  that host still has the agent installed and running, its next check-in reports it again and it
  comes back as a fresh proposal. To make it stop for good, uninstall the agent on that host
  (`sudo sh install.sh --uninstall`, see **Removing the agent** above) — or revoke the token it uses.

A discovered host also **fills in its own IP address** the moment it reports — you don't have to type
it. On every later report the IP is refreshed to the current value, **unless you've edited it by hand**
on the node — a manual IP is treated as yours and the agent never overwrites it.

**Each proposal now arrives already classified.** A newly discovered machine is proposed as a
**virtual machine**, a **container** or a **physical host**, based on what it reports about itself,
instead of every server landing as a physical host for you to correct one by one. When the agent
genuinely can't tell — the probe it relies on isn't installed — it proposes *physical host*, exactly
as before, rather than guessing. It's only a proposal: the Confirm dialog's **Kind** selector is
right there, and once you've confirmed a node **no later report ever changes its kind again**, even
if the machine starts reporting something different.

### Reviewing many at once

A single Docker host can add a dozen proposals in one check-in — itself plus a node per running
container — so the tray is built to be worked through in one pass rather than one dialog at a time.

- **Containers sit under the server that reported them.** Each group is headed by the server's name
  with a count of its containers, and the checkbox on that header takes the server **and** its
  containers together. That is how you confirm a host with everything on it in one action. If you
  already confirmed the server, its new containers still appear under its name.
- **Checkboxes and the two bulk buttons.** Tick what you want, then **Confirm selected** or **Discard
  selected**. Confirming in bulk does exactly what confirming one at a time does — you are still
  approving each of them, just not one dialog at a time. **Select everything shown** covers what is
  currently visible, never rows a filter is hiding.
- **The asset toggle is split.** In the bulk dialog, servers default to being tracked as inventory
  assets (as they do on their own) and **containers default to not being tracked**. A container is
  replaced by your next deploy, has no serial to record, and one busy host can add dozens — so they
  stay on the map without filling your asset list with rows nobody will maintain. Both switches are
  right there if your situation is different.
- **Re-classify the whole selection** with the kind selector if the agent got it wrong for all of
  them. Renaming stays on the single Confirm dialog, where it means something.
- **A partial result is reported as one.** If some items couldn't be applied — a serial that clashes
  with an existing asset, a proposal someone else discarded a moment earlier — the rest still go
  through and you are told how many, and which one failed first.
- **Filter** by name (`srv-*` works as a pattern) or IP, by subnet (`10.20.0.0/16`), by reported kind,
  and by servers-versus-containers — and **sort** by when something was first seen, or by name. These
  narrow what you're looking at; a bulk action never reaches past what you can see. **A filter that
  hides a ticked row takes it out of the action and out of the count**, so the number beside the
  buttons always means rows on screen. Widening the filter again brings it back, ticked and counted —
  which you can see happen, unlike a confirm you didn't know you were making.
- **One action takes at most 200 items.** Over that, the two buttons are disabled and tell you the
  number, before you press anything. Filter it down and run it in more than one pass.

### Auto-confirm rules

If you find yourself making the same call over and over — *"anything named `srv-*` on the management
VLAN is a VM, track it"* — you can write that down once. Open **Auto-confirm rules…** at the top of
the tray.

A rule has a **name**, what it **applies to** (servers, containers, or both), and at least one
condition: a **name pattern** (`*` for any run of characters, `?` for exactly one — the whole name has
to match), a **subnet** in CIDR form, or the **kind the agent's report made lazyit propose**. It then
says what to do: which kind to confirm it as, and whether to track it as an inventory asset.

**Be clear about what you're turning on.** A host a rule matches is confirmed the moment it reports —
you never see that row in the tray, and if the rule says to track it, its asset is created too. You
are still the one deciding; you're deciding *once, in advance*, for hosts you haven't met yet. That's
the whole point, and it's also the cost: the narrower the rule, the smaller the surprise. If someone
ever got hold of your agent's token, a host they invent that happens to fit one of your rules lands
confirmed instead of waiting in the tray.

What else you should know before writing one:

- **A rule only applies from the next report onwards.** Nothing already waiting in your tray is
  confirmed behind you — those are still yours to review, one at a time or in bulk. Saving a rule
  never touches a proposal you can already see.
- **A rule needs a condition that can actually rule something out.** A name pattern has to carry at
  least one literal character, and a subnet has to be narrower than `/0`. Most patterns made only of
  wildcards (`*`, `**`, `*?*`) match every host there is, just as `0.0.0.0/0` is every address there
  is, so lazyit refuses to save either — alone or together — because a rule that excludes nothing is
  just "confirm everything the agent finds", which is exactly what the pending tray exists to prevent.
  A few wildcard-only patterns do narrow: `?` on its own matches only one-character hostnames. lazyit
  refuses those too, deliberately, because "the pattern carries a literal character" is a line you can
  check by looking, and no estate is described by "hostnames of exactly one character" — the cost of
  refusing is only that those proposals wait in the tray, where they were going anyway.
  `srv-*` is a condition. `*` is not. You can still use `*` beside a real condition — *anything at
  all, on `10.20.0.0/16`* is a rule; *anything at all, anywhere* is not.
- **Anything you discarded stays discarded.** If you discard a proposal and the same machine reports
  again, it comes back as a new pending item for you to look at — a rule never confirms it behind you.
  Your "no" outranks your rules.
- **The asset switch starts off for any rule that can match containers.** A servers-only rule defaults
  to tracking them as assets; a containers rule *or* a "servers and containers" rule defaults to not
  tracking, for the same reason the bulk dialog does. Turn it on if those containers really are things
  you track.
- **It is still your decision, and it is recorded as yours.** The rule shows who wrote it, and every
  asset it creates is attributed to you, the same as if you had clicked Confirm. Rules are listed in
  the order they are checked (the number on the left) and the **first** one that matches wins.
- **You can take it back at any time.** The switch disables a rule immediately — from the next report
  onwards nothing matches it again — and deleting removes it. Servers it already confirmed stay
  confirmed: they are part of your inventory now, and un-confirming them would be as backwards as
  applying a rule to the past.
- **You can see whether it is doing anything.** Each rule shows how many times it has been used and
  when it last was.
- **A subnet rule never matches a host that reported no address**, and a **cloned machine ID** is
  never auto-confirmed — those two rows exist precisely so you can see them (see below).

### Containers show up as their own nodes

If the host runs **Docker** (or a Docker-compatible runtime) and the agent can read its socket, each
**running** container is proposed as its own **container** node, connected to the server it runs on by
a **runs-on** link. That link is the point: it's what makes the **blast radius** of a server — "what
breaks if this box goes down?" — include the containers on it, without you drawing a single
connection by hand.

A few things worth knowing:

- **Containers are proposals too.** They land in the same Pending review tray, and you confirm or
  discard them exactly like a server. A busy host can therefore add several proposals at once —
  which is what the grouping and bulk actions above are for: the tray puts a host's containers under
  its name, and its checkbox takes them together.
- **A recreated container is the same node.** Redeploying (`docker compose up`, an image bump) does
  not create a duplicate — containers are matched by **name** on that host, so your confirmed node,
  its position and its links survive a redeploy.
- **A container that stops** disappears from the report and its node is marked **offline**. It is
  never removed behind your back — removing it is your call, with the same Discard action. If it comes
  back under the same name, its node simply goes online again.
- **Only running containers are reported.** A stopped one-shot job isn't inventory worth mapping.
- **Nothing happens on hosts without Docker**, and an agent that can't read the container socket
  simply reports no containers — it never removes the container nodes you already have.
- The container's **image, image digest, runtime id and published ports** are shown on the node itself,
  in a read-only **Container** panel — open the container on the diagram or the Servers list. If you
  confirmed it with asset tracking on, the same panel appears on its asset page.

Once confirmed, a host keeps receiving fresh facts from the agent, but your edits — its name, kind,
position, IP and connections — are yours and the agent never overwrites them. The reported inventory —
operating system, CPU, memory, disks, network interfaces, serial and installed software — shows as a
read-only **Reported facts** panel right on the node (open a node on the diagram or Servers list), and
the same facts appear on the corresponding asset. Both stay fresh: each new report updates them
without touching anything you own (the asset's name, serial and model are never changed by a report).
This now includes **containers**: a container you confirmed as an asset keeps its image, digest, state
and published ports up to date on its asset page, where previously they stayed as they were the day
you confirmed it.

> [!tip] "Collected 3 days ago" does not mean the server stopped reporting
> The inventory panel is stamped with when those **facts were collected**, and lazyit only rewrites the
> stored inventory when something in it actually changed — a server whose software and hardware have
> been stable for a fortnight keeps a fortnight-old collection stamp while reporting perfectly well
> every few minutes. To ask *"is this host still checking in?"*, look at the server's **last reported**
> time on the Servers list or the node panel; that one advances on every single report.

## When two servers claim to be the same machine

lazyit tells your servers apart by the machine ID Linux writes at install time (`/etc/machine-id`).
That works — until a **VM template or golden image is built with one already in it**. Every machine
cloned from it then claims the same identity, and without a check they would all pile onto a single
row: one server on your map, twelve in your racks. It is the most common way an inventory ends up
confidently wrong, and it is why `systemd-firstboot` exists.

lazyit checks. When a report claims an ID that another server already uses, it compares the hardware
the two report: if the **serial number and the network-card addresses both differ**, they are two
machines, not one. Both, so that one legitimate change on a real server is never mistaken for a clone —
swapping a network card changes the addresses alone, replacing a board changes the serial alone.

The **hostname is deliberately not part of that check**: a machine cloned from a template usually
carries the template's name too, so requiring the names to differ would have let exactly the clones
this exists to catch slip through. When both servers do answer to the same name, the notification says
so — it is the clearest sign you are looking at a golden image.

When two machines are found:

- The new host gets **its own entry** in Pending review rather than overwriting the first one. Its
  reported facts, IP and hostname stay its own.
- **Nothing is merged and nothing is changed** on the server that was already there — the check can
  only ever hold a merge back, never rewrite something you already had.
- You get **one notification** in the bell (not one per check-in). Its title names both hosts; its
  summary opens with the command that fixes it (the bell shortens long summaries to one line — hover
  the row to read it in full). The row links to the topology map.

The fix is on the machines, not in lazyit: on each clone, remove `/etc/machine-id`, run
`systemd-firstboot --setup-machine-id`, and reboot. Fix the template too, or every future clone repeats
it. Once a clone has a real ID of its own it simply reports as a new host — confirm it, or use
**Merge into…** to fold it onto the entry lazyit created for it in the meantime.

All of this needs the hardware details a **current** agent sends — and it needs that agent to actually
have them. Two things leave a host out of the check, and both are silent:

- **An older agent.** Hosts still running an agent from before these details existed are never
  compared — and never warned about — until they check in with an updated one; nothing you already
  have is touched by the upgrade.
- **No serial to compare with.** The check needs a serial number *and* network-card addresses. The
  serial comes from `dmidecode`, which only answers when the agent runs **as root** and the tool is
  installed — and an **LXC or other container guest has no hardware serial at all**, root or not. A
  host with no serial is skipped exactly like a legacy one: lazyit reads a missing fact as "nothing to
  compare", never as a difference, so it will not warn on a guess.

So a fleet on the newest agent can still get **no clone detection whatsoever** — silently. The tell is
the **Reported facts** panel: if it shows no serial for a host, that host is not being checked. If
clone detection matters to you, run the agent as root with `dmidecode` installed, and expect nothing
from it on container guests.

## What the agent collects

- **Identity & hardware** — hostname, operating system and kernel, CPU and memory, disks and network
  interfaces, and (only when it runs as root) manufacturer / model / serial. It now reads **IPv6**
  addresses too: the interface list still shows each interface's IPv4, but a host that has no IPv4 at
  all finally gets an address on the infrastructure diagram instead of a blank.
- **What kind of machine it is** — server, desktop, laptop, virtual machine or container, and the
  virtualization it runs under (KVM, VMware, Hyper-V, Xen, LXC, Docker, WSL…) when it can tell. When
  it *can't* tell — the probe it relies on isn't installed — it reports **unknown** rather than
  guessing, and says so in the notes below. This is what lazyit uses to propose the **kind** of a
  newly discovered machine (see Pending review above); the raw values are stored alongside the host's
  other reported facts, and no screen displays them directly.
- **The containers it runs** — name, image, image digest, state and published ports, for each
  **running** container, when the host runs Docker (or a compatible runtime) and the agent can read
  its socket. Each one becomes its own node linked to the host, with those facts on a **Container**
  panel on the node (see Pending review above). This is still the local machine describing itself: the
  agent asks the runtime on that host what *it* is running — it never scans your network.
- **When it last booted** — a single timestamp, refreshed on each report, with no history kept: it's
  an inventory fact ("did this box actually reboot after the patch window?"), not uptime monitoring.
  Stored with the host's other reported facts and, like the machine type, not shown on any screen yet.
- **Installed software** — the list of installed packages, with versions where available. The agent
  also records which package manager reported each one; the package list itself shows the name and
  the version. On a busy server this list is by far the largest thing a report carries and it changes
  only when somebody installs or upgrades something, so the agent sends it **once and then sends only
  a fingerprint of it** until it changes — which cuts a routine check-in to roughly a tenth of its
  size. The panel still shows the whole list — the shorthand is only how it travels. One case is worth
  knowing: when the agent cannot enumerate packages at all (no supported package manager, or the
  collection timed out), lazyit **keeps the list it already holds** rather than emptying the panel, and
  the panel does not flag that on its own — the **Collected** date is what tells you how old the list
  is. An agent only starts skipping the list once lazyit has told it — in the reply to an earlier
  report — that this version understands the shorthand, so an agent upgraded ahead of its instance
  simply keeps sending the whole list. The saving arrives once both halves are new. The one moment to
  know about is the reverse move: **downgrading** an instance below this version while its agents are
  already new costs one report, whose list that older version reads as "no software" — the agent sees
  the older reply, and sends the whole list again on the report after it.
  If lazyit holds a list it can no longer match to the fingerprint (after restoring a backup, for
  instance), it **keeps the list it has** and asks the agent for a full one on its next report, rather
  than emptying the panel over a doubt. A server you **discarded** and that was then rediscovered is a
  different case, and worth knowing: it comes back as a brand-new record with no package list at all,
  so its Software panel is genuinely empty until the full list arrives with the next report — up to
  one reporting interval (15 minutes by default). Turning software collection **off** in the agent
  settings is different again, and deliberate: the stored list is cleared, so you are never left
  reading package versions nobody is collecting any more.
- **What it couldn't collect** — each report also says whether it ran with root and names anything it
  had to skip or that timed out. Run `lazyit-agent show` and it prints those notes right there,
  without sending anything, which is usually the fastest way to answer "why is this host's serial
  column empty?". (`lazyit-agent report --once --force` prints them too, and sends the report.)
  lazyit also stores them alongside the host's reported facts, so a future fleet view
  can answer it for the whole estate; today nothing displays them in the interface.

It collects whatever it can and simply omits anything it can't read, so an unprivileged install still
reports a useful picture. It **never** reads secrets, files or application data, and it sends no
metrics.

## What changed, and when

Every panel above shows a machine **as it is now**. The **Changes** tab on a node shows the moments it
**moved** — the answer to *"someone upgraded OpenSSL on db-01 last Tuesday and broke the app"*.

Open a machine on the infrastructure diagram and switch from **Overview** to **Changes**. Each entry
names what changed, its value before and after, and when lazyit recorded it. Newest first, with a
button at the bottom to load older entries.

**Only real changes are recorded.** A host that checks in every five minutes and never changes adds
nothing at all — the list stays empty, however long it has been reporting. An entry appears when:

- a package is **installed**, **removed**, or its **version changes** (an upgrade or a downgrade);
- the **operating system**, its **version** or the **kernel** changes;
- **memory**, **total disk capacity** or the **number of disks** changes;
- the **hardware serial** changes;
- a container's **image** or its **image digest** changes — that last one is the useful one, because a
  digest moves when a `:latest` tag is re-pulled and nothing else on screen would tell you.

**A few things are deliberately not recorded**, because they would fill the list with noise rather
than answers:

- **A machine's first report.** The first time lazyit sees a fact, it simply remembers it — it does not
  record "3,000 packages installed". The same applies the first time any individual fact appears on a
  host that had been reporting without it (a serial showing up after you give the agent root, for
  example). Changes start being recorded from the second observation onwards, which is also why a
  freshly upgraded instance starts with an empty list on every machine.
- **A fact that disappears.** If the agent stops running as root, the serial stops arriving — that is
  the agent losing an ability, not the chassis being swapped, so nothing is recorded.
- **A container restarting.** That is liveness, and it is already on the node's status.
- **Turning software collection off** in the agent settings. That clears the stored package list, as
  documented above, but it is a settings change — it is not recorded as thousands of removals.

**A machine that has been offline for a long time is capped.** When a host comes back after missing
several patch windows, its first report can legitimately differ by thousands of packages. lazyit
records up to **200 entries per machine per report** so one check-in cannot bury the list, and up to
**500 per machine per hour**. Anything beyond that is not recorded; already-recorded entries are never
removed. In normal operation you will never approach either number.

The tab is **read-only** — entries are written by the agent and nothing else, and there is nothing to
edit or delete. Removing a machine from the map hides its history along with the machine; restoring it
brings both back.

> [!info] No agent update needed
> This works with the agents you already have installed. lazyit compares each report against what it
> already holds, so nothing on your hosts has to change for the Changes tab to start filling.

## Configure every agent from one screen

You do not edit agents host by host. **Settings → Instance → Reporting agents** sets the policy for
every agent in the estate, and each one picks it up on its next check-in.

What you can set there:

- **How often each host reports** — from 5 minutes to 24 hours. This is the setting that used to mean
  editing a systemd timer on every machine.
- **How long lazyit waits before calling a host offline.** It must be longer than the reporting
  interval, or a perfectly healthy host gets marked offline between two of its own reports — the
  editor will not let you save a value that would do that.
- **Which collectors run** — hardware, disks, network interfaces, installed software, containers. A
  collector that is off is never run at all: the agent does not gather the facts and then throw them
  away.
- **What to leave out** — name patterns for network interfaces (`veth*`, `docker*`), mountpoints
  (`/var/lib/docker/*`, `/snap/*`) and packages (`linux-image-*`), plus a hard cap on how many
  packages a host may report. `*` matches anything and `?` matches a single character; regular
  expressions are not accepted.

Three things are worth knowing before you use it.

**A change lands on the next report, not instantly.** The policy travels back on each host's
check-in, and the host applies it from the run *after* that — so allow up to two reporting intervals.
That delay is deliberate: an agent only ever applies a policy it already had in hand when it started,
so a mistake here can never interrupt a fleet halfway through collecting.

**Each host can refuse, and lazyit cannot override that.** A host's own `/etc/lazyit-agent/config`
can turn a collector off (`LAZYIT_COLLECT_SOFTWARE=false`), set a floor on how often it will report
(`LAZYIT_MIN_INTERVAL=3600`), cap its own package list (`LAZYIT_SOFTWARE_MAX=500`) or add its own
exclusions (`LAZYIT_EXCLUDE_NICS=veth*`). Those settings **win**, always, and nothing you set in
lazyit can switch a locally-disabled collector back on. This is on purpose: lazyit is self-hosted, and
the person who owns a server is not always the person who administers lazyit. Local settings can only
ever make a host report *less*, never more. **Re-running the install command keeps them.** Upgrading
an agent rewrites that file, so the installer carries every `LAZYIT_*` line it finds across — apart
from the three it owns itself (`LAZYIT_URL`, `LAZYIT_TOKEN` and the obsolete `LAZYIT_INTERVAL`, which
nothing reads any more) — and fences what it kept under a
`--- kept from this host's previous config ---` marker so you can see exactly what survived. An
upgrade never quietly switches a collector back on.

**lazyit can never tell an agent to run something.** The policy is a fixed list of on/off switches,
numbers and name patterns — there is no field for a command, a script, a file path or a regular
expression, and there is no plan to add one. That is what keeps the worst case of a stolen agent token
at "proposals you discard" rather than "someone else's code running as root on every server you own".

**Did it take?** Each host reports back which version of the policy it is running, so you can tell
"configured" from "actually applied". Open a server on the [infrastructure
diagram](/help/assets-topology-diagram) and its panel shows **Policy v7 · applied** or **Policy v8 ·
pending** — pending simply means that host has not checked in since your change. A server discovered
by an agent older than this release shows neither, because it never reports a policy version at all.

## Security

- **One narrow permission.** The token holds **only** `infra:report`. It cannot read or change
  anything else in lazyit — not assets, not secrets, not other infrastructure. The worst a leaked
  token can do is create proposals you discard.
- **A human gate.** Everything the agent reports lands as **Pending** and only becomes part of your
  inventory when you confirm it. An automated writer can never silently change your official records.
- **No secrets, ever.** The agent carries no keys and reads no vault — your secret values are
  untouched.
- **A confined service.** The agent runs as root, because reading a machine's serial number and model
  requires it — but the systemd unit it runs under is restricted well below what root can normally
  do: it cannot gain new privileges, cannot see users' home directories, gets a private `/tmp`, and
  cannot modify kernel settings, control groups, or even its own program and configuration. Open
  `/etc/systemd/system/lazyit-agent.service` and read it; it is short, and it is written to be read.
  It also runs at the **lowest CPU and disk priority the system has**, so listing three thousand
  packages on a busy database server never competes with what that server is for.
- **The download is checksummed.** Your instance publishes a fingerprint of the agent binary next to
  the binary itself, and the installer refuses to install one that doesn't match. This is an
  integrity check, not a cryptographic signature — it catches a corrupted or stale download, and a
  tampered file where only one of the two was changed. Pass `--require-checksum` to make a *missing*
  fingerprint fatal too.
- **It can use your CA, not the machine's.** `--ca-file` (or `LAZYIT_CA_FILE` in the config) points
  the agent at a certificate bundle it alone trusts, so an internal certificate authority never has
  to be installed machine-wide just so one inventory agent can report.
- **Self-hosted and air-gapped-safe.** The install command points at *your* instance, the agent talks
  only to that instance, and it works fully offline. Tokens are revocable any time from
  [Service accounts](/help/users-permissions-service-accounts).
- **Report limits.** Each token is limited two ways: **how often** it may report (default 120 times
  per minute) and **how many newly discovered nodes** it may add (default 100 per hour — a discovered
  container counts the same as a discovered server, since both are rows in your inventory). Together
  they protect your database from a runaway or stolen agent — a token can no longer fill it with
  proposals. Both defaults assume roughly a **100-server** estate sharing one install token, so a
  normal rollout never hits them: all 100 servers can be discovered inside the first hour. Two things
  are worth knowing. A node you've **already confirmed keeps reporting no matter what** — server or
  container alike. Reaching a limit delays only *new* discoveries, never the liveness and inventory
  of what you already have: a container that is still running is never marked offline just because
  the limit stopped the server from adding a *different* one. It can't make your map show a false
  outage. And **nothing needs cleaning up** to
  recover: an agent that was turned away simply succeeds on its next attempt in the following window.
  How full your Pending tray is does not affect these limits at all. Rolling out more than 100
  servers at once? Either let it settle over a couple of hours, or raise
  `INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW` (and `INFRA_REPORT_MAX_PER_WINDOW`, the reports allowed per
  minute) in your instance's environment and restart it.

## Keeping the agent current

Each agent stamps its own version into every check-in. When an agent falls a **major version** behind
your server, its row (and its detail panel) shows a small **Agent outdated** badge — a hint to
re-run the install command and pick up the latest binary. It's only a nudge: an outdated agent keeps
reporting normally, nothing is blocked, and minor updates don't raise it. Agents built from source (or
before versioning was added) report as `dev` and never show the badge.

**Some improvements only arrive when you re-run the install command.** The agent is two things: a
program, and the systemd service and timer that run it. Anything in the *program* — the diagnostics
above, proxy and certificate-authority support — comes with a new binary. Anything in the *service
and timer* — the confinement and low priority described under Security, and the spread-out schedule
that stops a whole estate reporting in the same second after a maintenance window — is written when
the installer runs, and an existing host keeps the unit it was originally given until you re-run it.
Re-running is safe and keeps that host's own settings, so on a fleet you already have, this is worth
doing once.

**Upgrading your instance never breaks the agents already installed.** You do not have to re-install
anything: an older agent keeps reporting exactly as it did, and every fact it sends lands exactly where
it did before. In particular, **nothing you already have is re-classified**: the machine-kind proposal
above applies only to servers discovered *from now on*, so every node in your inventory keeps the kind
it has, and an older agent that reports no containers never removes container nodes.

**From this version onwards, the reverse also holds.** A *newer* agent reporting to an older server is
accepted: the server takes every fact it understands and simply notes the ones it doesn't, rather than
rejecting the whole report. That distinction matters — a rejected report would make the server
disappear from your inventory and look like an outage, while a stale field never does. Note the "from
this version onwards": instances older than this release still refuse a report that mentions anything
they don't recognise, so if you plan to run agents that update on their own schedule, upgrade the
instance first.

## What's next

- [Infrastructure diagram](/help/assets-topology-diagram) — the map the confirmed servers appear on.
- [Servers list](/help/assets-topology-servers) — the table where the Pending review tray lives.
- [Service accounts](/help/users-permissions-service-accounts) — manage or revoke the agent's token.
