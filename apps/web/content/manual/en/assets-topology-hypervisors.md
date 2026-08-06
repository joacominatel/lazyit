---
title: Hypervisor hosts
category: assets
subcategory: topology
order: 4
---

# Hypervisor hosts

If a machine in your estate **is** a hypervisor — a Proxmox VE node, a Hyper-V server, a Linux box
running KVM through libvirt — the [reporting agent](/help/assets-topology-reporting-agent) installed
on it does one more thing: it reports **the guests that host is running**, so the virtual machines
and containers living on it appear on your map without an agent inside each one, connected to their
host by the **runs-on** link that makes blast radius mean something.

There is nothing to set up for this. You install **the same agent, with the same one-liner**, on the
hypervisor host exactly as you would on any other server — no API token, no extra credential, no
separate collector to enable. The agent detects for itself that it is running on a hypervisor and
starts including the guest list in its ordinary reports; the installer prints what it detected
(*"Detected: Proxmox VE — this host's QEMU VMs and LXC containers will be inventoried"*) so you know
before the first report lands. Detection is re-checked on **every** report, so a machine that becomes
a hypervisor later — you enable the Hyper-V role, you install Proxmox — simply starts reporting its
guests on the next check-in, with nothing to re-install.

It works on:

- **Proxmox VE** — QEMU virtual machines *and* LXC containers, read locally on the node itself.
- **Hyper-V** — through the Windows agent already on the host.
- **libvirt/KVM** — a generic Linux host running virtual machines under libvirt.

> The guest list is still the local machine describing itself — the host asking its **own**
> hypervisor what it is running, the same way a Docker host reports its own containers. The agent
> never scans your network and never calls a remote hypervisor API.

**VMware is the honest exception: ESXi hosts cannot run agents** — the platform does not allow
installing third-party software on the hypervisor itself — **and vCenter support is planned as a
server-side connection**, configured in lazyit rather than installed on a host. Until that ships,
VMware guests appear the way everything else did before agents: run the agent inside the guests you
care about, or add them by hand.

One more platform is worth naming: on **XCP-ng / XenServer** the agent *detects* the hypervisor and
says so, but does not collect its guests yet — an honest "detected, not inventoried" beats a
half-working list.

## What appears, and where

Each guest the host reports lands in the **Pending review** tray on the Servers view — the same tray,
the same rules as every discovery — grouped under its hypervisor host, and connected to it on the map
by a **runs-on** link once confirmed. Nothing enters your live inventory until you confirm it, one at
a time or [in bulk](/help/assets-topology-servers).

- A **QEMU, Hyper-V or libvirt guest** is proposed as a **virtual machine** node; a **Proxmox LXC
  container** is proposed as a **container** node.
- A guest is matched by the platform's own stable identifier (the Proxmox VMID, the Hyper-V VM GUID,
  the libvirt domain UUID), so renaming a VM does not create a duplicate.
- Like containers, guests **default to not being tracked as assets** when you confirm them — a
  homelab-sized host can carry dozens — and the toggle is right there if a VM is something you track.
- A guest that **disappears from the host's report** — deleted, or migrated away — has its node
  marked **offline**. It is never removed behind your back; Discard stays your call, and the same
  guest returning brings the node back online.
- On a **Proxmox cluster**, each node reports only **its own** guests, so a cluster where every node
  carries the agent covers the whole estate with no overlap.

A busy host can propose a lot at once. Guests enter through the same discovery limits as everything
else, so a host with hundreds of VMs fills the tray **gradually over an hour or two** on its first
report rather than all in one burst — that is the flood protection working, not guests being lost.

## One machine, one node

The obvious worry: if a VM runs its **own** agent *and* its hypervisor reports it, do you get two
nodes for one machine? No — **they converge automatically**. The hypervisor knows each guest's
firmware identity (its SMBIOS UUID) and its network-card addresses; the agent inside the guest
reports the same facts from the other side. When both match — the identity **corroborated** by a
network-card address, never on a single signal — lazyit folds the host's view into the guest's own
node: the in-guest agent's record wins (it has the real inventory — the software, the disks, the
machine identity), and the **runs-on** link lands on it. You end up with one node that both knows
what it runs *and* where it runs.

When the corroboration is not there — cloned VMs really do ship duplicate firmware identities — the
two rows are surfaced as a **possible duplicate** for you to check and merge, never merged for you.

A guest with **no** agent of its own is simply represented by the host's view: a confirmable,
trackable node that goes offline when the guest does. Install an agent inside it later and the two
converge the same way.

### When a Windows VM stays as two rows

There is one case where the automatic merge **cannot** happen, and lazyit now tells you instead of
staying quiet about it. Some virtual machines present their firmware in a way **Windows cannot
read** — Windows reports no SMBIOS UUID at all, so there is no firmware identity to match against
the hypervisor's. This is common on **Proxmox VE**, and only for **Windows** guests: Proxmox freezes
a Windows VM's virtual hardware version at the moment you create it, so a VM created on PVE 8.1 or
8.2 keeps that hardware forever, while the Linux VMs beside it are unaffected and converge normally.

When that happens you will see a **possible duplicate** notification saying a network card matches
but there is no UUID to confirm it. lazyit deliberately does **not** merge on a network card alone —
one fact is a hint, never a merge. Two things you can do:

- **Merge them once, from the tray.** **Merge into…** folds the hypervisor's row into the VM's own
  node, keeping everything you set. This is the quick answer and it sticks.
- **Or repair the VM, and it fixes itself.** In Proxmox, raise the VM's **Machine** version (VM →
  Hardware → Machine) to a current one, or add `-machine smbios-entry-point-type=32` to its `args`,
  then reboot the guest. Windows can read the firmware again and the two rows converge on their own
  from the next report onwards — no merge needed.

**Upgrading to this version?** The first report from each affected host will raise these
notifications for pairs that were already silently split — you are seeing existing duplicates
surface, not new ones being created. Rows that already forked **do not merge themselves**: use one
of the two options above. You get one notification per (guest, network card), not one per report, so
a host full of affected VMs rings once each and then stays quiet.

## Cluster migrations

When a VM **migrates between Proxmox cluster nodes**, node A stops reporting it and node B starts —
so its old node goes **offline** under A and a **new pending proposal** appears under B. lazyit
notices the two look like the same machine and shows the **duplicate-suspicion hint** in the merge
dialog; **Merge into…** folds them into one, keeping everything you set. This is deliberately a
one-click *suggestion* rather than an automatic merge — a wrong merge is expensive, a hint is cheap.
A guest running its own agent skips all of this: its one canonical node just gets its runs-on link
re-pointed to the new host.

## Turning it off

Guest inventory follows the same three controls as every other collector, and the off switch always
wins over the on one:

- **At install time** — add `--no-hypervisor` to the Linux install command, or `-NoHypervisor` on
  Windows. This writes the veto below into the host's config for you.
- **On the host** — set `LAZYIT_COLLECT_HYPERVISOR=false` in the agent's own config file
  (`/etc/lazyit-agent/config` on Linux, `C:\ProgramData\lazyit-agent\config` on Windows). As with
  every local setting, this **wins over anything set in lazyit** and survives agent upgrades.
- **Centrally** — the **Hypervisor guests** switch in **Settings → Reporting agents**, which turns it
  off for every agent in the estate on their next check-in. It is **on by default**: detection
  already gates collection, so on a host that is not a hypervisor the switch changes nothing.

Turning it off stops future guest reports; the guest nodes you already confirmed stay where they are,
going offline as their reports stop, and Discard remains yours.

> The agent reads the guest **list** — names, identities, state, sizing — never the guests'
> contents. It does not look inside a guest's disks, does not need an agent or any tooling installed
> in the guests, and sends no metrics. It is inventory, in the same narrow sense as everything else
> the agent does.
