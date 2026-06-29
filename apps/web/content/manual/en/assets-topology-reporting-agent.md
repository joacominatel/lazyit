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

   The address is **your own lazyit instance** — the agent only ever talks to the server you run. Run
   it on a **Linux** server **as root**. The token is shown **only once**, so copy it (or download it)
   before continuing. If you'd rather inspect every step, expand **Install manually (step by step)**
   for the same install done by hand (download the binary, install it, write the config file, send a
   test report).
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
  owner, knowledge-base links and secret references like any other asset. Turn it off to keep the
  node graph-only.
- **Discard** — removes the proposal. This is a soft delete (the same as removing any node from the
  map): nothing is destroyed and it can be restored later.

Once confirmed, a host keeps receiving fresh facts from the agent, but your edits — its name, kind,
position and connections — are yours and the agent never overwrites them.

## What the agent collects

- **Identity & hardware** — hostname, operating system and kernel, CPU and memory, disks and network
  interfaces, and (only when it runs as root) manufacturer / model / serial.
- **Installed software** — the list of installed packages, with versions where available.

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

## What's next

- [Infrastructure diagram](/help/assets-topology-diagram) — the map the confirmed servers appear on.
- [Servers list](/help/assets-topology-servers) — the table where the Pending review tray lives.
- [Service accounts](/help/users-permissions-service-accounts) — manage or revoke the agent's token.
