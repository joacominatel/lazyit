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

   > **LAN deployment (no public domain)?** If your instance is reachable only by a LAN IP or hostname
   > with a self-signed certificate, trust that certificate authority on the agent host **before**
   > running the install command, or the download will be rejected as untrusted. See your deployment's
   > LAN runbook for the one-line helper that does this.
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
   sudo lazyit-agent report --once
   ```

## Pending review

Discovered hosts don't go straight into your inventory — they wait for you in the **Pending review**
tray at the top of the Servers view, each showing its hostname, kind, where the report came from and
how long ago it last reported. For each one you have two choices:

- **Confirm** — adds the host to your live topology. A short dialog lets you rename it and change its
  kind first, and offers a **Track as an inventory asset** toggle (**on** by default): left on,
  lazyit also creates a tracked **asset** carrying the reported host facts, so the server can have an
  owner, knowledge-base links and secret references like any other asset. If the host reported a real
  hardware **serial number**, it becomes that asset's serial automatically (a placeholder like
  *"To be filled by O.E.M."*, or a serial already used by another asset, is skipped). Turn the toggle
  off to keep the node graph-only.
- **Discard** — removes the proposal. This is a soft delete (the same as removing any node from the
  map): nothing is destroyed and it can be restored later. **Discarding does not stop the agent.** If
  that host still has the agent installed and running, its next check-in reports it again and it
  comes back as a fresh proposal. To make it stop for good, uninstall the agent on that host — or
  revoke the token it uses.

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

### Containers show up as their own nodes

If the host runs **Docker** (or a Docker-compatible runtime) and the agent can read its socket, each
**running** container is proposed as its own **container** node, connected to the server it runs on by
a **runs-on** link. That link is the point: it's what makes the **blast radius** of a server — "what
breaks if this box goes down?" — include the containers on it, without you drawing a single
connection by hand.

A few things worth knowing:

- **Containers are proposals too.** They land in the same Pending review tray, and you confirm or
  discard them exactly like a server. A busy host can therefore add several proposals at once.
- **A recreated container is the same node.** Redeploying (`docker compose up`, an image bump) does
  not create a duplicate — containers are matched by **name** on that host, so your confirmed node,
  its position and its links survive a redeploy.
- **A container that stops** disappears from the report and its node is marked **offline**. It is
  never removed behind your back — removing it is your call, with the same Discard action. If it comes
  back under the same name, its node simply goes online again.
- **Only running containers are reported.** A stopped one-shot job isn't inventory worth mapping.
- **Nothing happens on hosts without Docker**, and an agent that can't read the container socket
  simply reports no containers — it never removes the container nodes you already have.
- The container's **image, digest and published ports** are recorded with the node's reported facts.
  No screen displays them today.

Once confirmed, a host keeps receiving fresh facts from the agent, but your edits — its name, kind,
position, IP and connections — are yours and the agent never overwrites them. The reported inventory —
operating system, CPU, memory, disks, network interfaces, serial and installed software — shows as a
read-only **Reported facts** panel right on the node (open a node on the diagram or Servers list), and
the same facts appear on the corresponding asset. Both stay fresh: each new report updates them
without touching anything you own (the asset's name, serial and model are never changed by a report).

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
  its socket. Each one becomes its own node linked to the host (see Pending review above). This is
  still the local machine describing itself: the agent asks the runtime on that host what *it* is
  running — it never scans your network.
- **When it last booted** — a single timestamp, refreshed on each report, with no history kept: it's
  an inventory fact ("did this box actually reboot after the patch window?"), not uptime monitoring.
  Stored with the host's other reported facts and, like the machine type, not shown on any screen yet.
- **Installed software** — the list of installed packages, with versions where available. The agent
  also records which package manager reported each one; the package list itself shows the name and
  the version.
- **What it couldn't collect** — each report also says whether it ran with root and names anything it
  had to skip or that timed out. Run the agent by hand (`lazyit-agent report --once`) and it prints
  those notes right there, which is usually the fastest way to answer "why is this host's serial
  column empty?". lazyit also stores them alongside the host's reported facts, so a future fleet view
  can answer it for the whole estate; today nothing displays them in the interface.

It collects whatever it can and simply omits anything it can't read, so an unprivileged install still
reports a useful picture. It **never** reads secrets, files or application data, and it sends no
metrics.

## Security

- **One narrow permission.** The token holds **only** `infra:report`. It cannot read or change
  anything else in lazyit — not assets, not secrets, not other infrastructure. The worst a leaked
  token can do is create proposals you discard.
- **A human gate.** Everything the agent reports lands as **Pending** and only becomes part of your
  inventory when you confirm it. An automated writer can never silently change your official records.
- **No secrets, ever.** The agent carries no keys and reads no vault — your secret values are
  untouched.
- **Self-hosted and air-gapped-safe.** The install command points at *your* instance, the agent talks
  only to that instance, and it works fully offline. Tokens are revocable any time from
  [Service accounts](/help/users-permissions-service-accounts).
- **Report limits.** Each token is limited two ways: **how often** it may report (default 120 times
  per minute) and **how many newly discovered nodes** it may add (default 100 per hour — a discovered
  container counts the same as a discovered server, since both are rows in your inventory). Together
  they protect your database from a runaway or stolen agent — a token can no longer fill it with
  proposals. Both defaults assume roughly a **100-server** estate sharing one install token, so a
  normal rollout never hits them: all 100 servers can be discovered inside the first hour. Two things
  are worth knowing. A server you've **already confirmed keeps reporting no matter what** — reaching
  a limit delays only *new* discoveries, never the liveness and inventory of the servers you already
  have, so it can never make your map show a false outage. And **nothing needs cleaning up** to
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
