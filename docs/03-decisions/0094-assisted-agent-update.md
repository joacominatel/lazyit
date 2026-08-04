---
title: "ADR-0094: Assisted agent update — the server names who is behind and hands over the command"
tags: [adr, agent, infra, updates, versioning, fleet, security, backend, frontend]
status: proposed
created: 2026-08-04
updated: 2026-08-04
deciders: [Joaquín Minatel]
---

# ADR-0094: Assisted agent update — the server names who is behind and hands over the command

## Status

**accepted** — 2026-08-04 (issue #1204, split out of epic #1146 item 3, "Opt-in self-update"). Design
only: no code, no migration and no Manual page ship with this record. It **extends**
[[0074-server-reporting-agent]] (§6 distribution, §7 the agent) and the #907 amendment of
[[0083-versioning-and-releases]], and it is the **agent-side sibling of**
[[0084-update-awareness-and-guided-update]] — same posture, same red line, one layer out. It
**absorbs epic #1146 item 1** ("agent fleet view", §4) and **declines** item 3 as written (§Considered
options). **#1203 is a hard prerequisite** (§2).

> **Scope.** The server already knows every agent's version; nothing reads it. This ADR makes it
> **legible** — a fleet view that answers *how many agents, on what versions, who has not checked in* —
> and **actionable** — the exact, correctly-flagged install command for each host that is behind, ready
> to paste or to push through the operator's existing config management.
> **Non-goals, stated as such and not as a v1 scope cut:** no agent change, no self-replacement, no
> re-exec, no `agentUpdate` field on the ack, no server-pushed execution of any kind, no new
> notification type, and **no migration**.

## Context

### What item 3 proposed, and what the ground turned out to be

Epic #1146 item 3 proposed **self-update**: the report ack carries `agentUpdate { version, sha256 }`,
the agent downloads its replacement from the instance, verifies the digest, atomically renames and
re-execs. The transport for that genuinely exists — the binary is already instance-served and
version-locked ([[0074-server-reporting-agent]] §6), #1138 deliberately loosened the report root
*naming self-update as one of its reasons*, and the ack is parsed loosely by the agent (a cast, not a
zod parse), so an additive field would reach a running fleet without breaking it. **The constraint was
never plumbing. It is architectural permission**, and a mapping pass found the shape collides with
more than one thing.

**Two accepted red lines.** Both are quoted in full in §1, because confronting them is the entire
reason this shape was chosen: [[0084-update-awareness-and-guided-update]]'s *"No auto-apply, ever"*
and [[0074-server-reporting-agent]] §7's *"No server-pushed commands, scripts, paths or file reads.
Ever."*

**Two structural blockers, on the two platforms lazyit actually ships.**

- **Linux: the agent is sandboxed so that it cannot do this.** `install.sh` writes
  `ProtectSystem=full` into the unit (`apps/web/public/install.sh:535-536`, #1137) and the comment
  above it says why in the repo's own words: *"ProtectSystem=full leaves /var writable while making
  /usr, /boot and /etc read-only, so the agent cannot rewrite its own binary or its own config"*. A
  self-updating agent needs that line removed or an escape carved around it. It is not an oversight to
  clean up; it is a documented security property, and it is one of the first things a buyer's
  reviewer looks at on a `curl | sh` installer that runs as root.
- **Windows: the running `.exe` is loader-locked**, and the replacement would have to happen from
  inside that same process, inside a scheduled task with `ExecutionTimeLimit` of 5 minutes
  (`apps/web/public/install.ps1:131`). The workable shapes are a helper process outliving its parent
  or a pending-rename reboot dance — both of which are a second executable and a second failure mode
  on the platform where the estate is largest ([[0074-server-reporting-agent]] §7, #1144: ~180 Windows
  endpoints and ~25 servers against ~40 Linux boxes).

**No rollback exists.** Neither platform retains a previous binary, and neither installer keeps one.
[[0084-update-awareness-and-guided-update]] §3.10 treats *keeping the rollback target* as mandatory
for the analogous server update — *"the previous checkout, its images, and the pre-update dumps
survive until the operator confirms the new version healthy"*. Self-update would ship the strictly
more dangerous operation (245 hosts, unattended, as root/SYSTEM) with strictly less safety net than
the operation lazyit already refuses to automate on one host.

### The prerequisite defect, and the honest state of what ships today

**Every Docker-built instance serves agent binaries that report `agentVersion: "dev"`** — #1203. The
`agent-builder` stage receives no `APP_VERSION`, `.git` is excluded from the build context, so
`apps/agent/package.json`'s `--define` falls through to its `|| echo dev` fallback. The consequence is
not cosmetic: `isMajorBehind("dev", "v1.10.0")` is fail-soft `false`, so the shipped **"Agent
outdated" badge** (#907, `apps/web/app/(app)/assets/diagram/_components/agent-provenance.tsx:55`)
renders nothing for every agent on every Docker install. A feature that shipped is silently dead, and
"who is behind" is not merely hard to compute — it is **unknowable**.

### Two facts about credentials that shape the answer

- **Both installers require a token on every run**, including a re-run over an existing install
  (`install.sh:208`, `install.ps1:332`). The config merge deliberately carries every unknown
  `LAZYIT_*` key across an upgrade but **re-supplies the three keys the installer owns** — `URL`,
  `TOKEN`, `INTERVAL` (`install.sh:465`).
- **The server cannot re-emit an existing token.** A service account stores only `tokenHash` +
  `tokenPrefix` (`apps/api/src/service-accounts/service-accounts.service.ts:93,107`); the plaintext is
  shown once, at mint or rotate. So a per-host command lazyit generates for an *already-installed*
  host structurally cannot contain that host's working credential. §6 decides what it contains
  instead.

### What already exists and must not be rebuilt

`InfraNode.agentVersion` as a first-class column (migration `20260702010000_infra_node_agent_version`,
#907) · `lastReportedAt` + the OFFLINE staleness sweeper ([[0074-server-reporting-agent]] §4) ·
`ServiceAccount.lastUsedAt` · the `#1138` `AgentOsFamily` platform discriminator, collected on every
report · the `isMajorBehind` / `isNewerVersion` helpers in `packages/shared/src/utils/semver.ts` ·
and `apps/web/app/(app)/assets/diagram/_components/agent-install-commands.ts`, which **already builds
the correctly-flagged command for both platforms**, including the post-#1190 http opt-in.

## Considered options

### Shape A — full self-update *(rejected)*

The ack carries `agentUpdate { version, sha256 }`; the agent replaces its own binary and re-execs,
gated behind a policy flag defaulting off, never across a MAJOR.

**Rejected.** It crosses both red lines at once (§1), and to ship it lazyit would have to spend
`ProtectSystem=full` — trading a documented, inspectable security property for an ergonomic one, in
the one file (`install.sh`) that a security-minded evaluator reads before they read anything else.
The gating does not rescue it: an opt-in flag is an application-layer control over a host-layer
capability, which is precisely the reasoning
[[0084-update-awareness-and-guided-update]] used to reject the Docker-socket sidecar. And it would
ship an unattended, fleet-wide, root-privileged binary replacement **with no rollback path on either
platform**, which is a worse safety posture than the single-host server update lazyit already refuses
to automate. Not deferred pending effort — declined on its shape.

### Shape C — human-triggered, agent-executed *(rejected for now, with a reopening criterion)*

An admin clicks "update these 40 agents"; the ack for those specific hosts carries the update
instruction on their next check-in; the agent executes it. No schedule, no unattended path — a human
initiates every run.

**Rejected for now.** It clears [[0084-update-awareness-and-guided-update]]'s red line (a human
triggers it) but **not** [[0074-server-reporting-agent]] §7's: the server would still be pushing an
instruction that a root process acts on, and §7 pre-declared that any escape there *"needs a new ADR
and a very good reason"*. The two structural blockers and the missing rollback apply to C exactly as
they do to A — the human click removes the *scheduling* risk, not the *mechanism* risk. Shape C is
therefore genuinely the incremental next step, and it is the right one to revisit first, but it is not
first.

**What would justify revisiting C** — recorded so this is a decision with a door, not a dead end.
Reopen when **all** of the following are true, and reopen with a new ADR that amends
[[0074-server-reporting-agent]] §7 explicitly rather than quietly:

1. **Shape B is in production and demonstrably insufficient** — operators using the fleet view still
   report the update as the bottleneck, with an estate size where copy-paste plainly does not scale
   (the epic's own line was "does not scale past ~15 hosts"; B's config-management handoff is the
   claim that must fail first).
2. **A rollback target exists on both platforms** — the installer retains the previous binary and a
   documented one-command revert, matching the standard
   [[0084-update-awareness-and-guided-update]] §3.10 already sets for the server.
3. **A Windows self-replacement design exists that is not a second executable** — or the second
   executable is designed, signed and reviewed as a first-class artifact rather than discovered
   halfway through implementation.
4. **The Linux sandbox is not weakened for it** — a design that needs `ProtectSystem=full` removed is
   the same rejection, wearing a different shape.

Absent all four, C stays closed.

### Shape B — assisted update *(chosen)*

The server computes and shows which agents are behind, and hands the operator the exact command to run
— by hand, or pushed through the config management they already have. **No agent change. No
self-replacement. No server-pushed execution.** The instruction travels from the server to a *human*,
who decides whether and when a root process runs anything.

**Chosen** because it delivers the operator value item 3 was actually reaching for — *knowing* which
of 245 hosts are stale, and not having to hand-derive 245 commands — while sitting on the safe side
of both red lines by construction rather than by promise, needing **zero** change to the agent, the
report contract, the ack, the installers or the schema.

## Decision (Shape B)

### §1 — The two red lines, and which side of them this is on

The lines, quoted rather than paraphrased:

> **"No auto-apply, ever.** No scheduled or unattended update path exists, in any configuration."
> — [[0084-update-awareness-and-guided-update]], §Red lines

> **"No server-pushed commands, scripts, paths or file reads. Ever."** […] *"the moment the server can
> push executable content to a root agent, §8's honest worst case ('PENDING spam a human discards')
> becomes remote code execution as root on every host in the estate, and the security argument for the
> `curl | sh` installer collapses with it."*
> — [[0074-server-reporting-agent]], §7 hard rule 2

**Against the first line.** Assisted update applies nothing. It has no scheduler, no trigger, no
queue, no unattended path, and no code that runs on a host at a time lazyit chose. Every state
transition on a managed host is initiated by a human typing or scheduling a command *in their own
tooling*. The scenario the line was written against — *"it updated itself at 3am and broke"* — has no
mechanism to occur here, because there is nothing that can act at 3am.

Note also that the line is written in [[0084-update-awareness-and-guided-update]]'s own scope (the
server's checkout + migrations) but is phrased unqualified, in the section operators are pointed at.
**This ADR reads it at face value and stays inside it anyway** — the safe move when a red line is
broader than its author's immediate subject. It does not narrow, reinterpret or amend it. (Whether
[[0084-update-awareness-and-guided-update]] should scope that sentence explicitly is a question for
the CEO, §Decisions needed — this record deliberately does not answer it by editing another ADR.)

**Against the second line.** Nothing new travels server→agent. `AgentPolicySchema` stays a
`z.strictObject` at every depth over booleans, integers and globs; the ack gains no field; the report
contract is untouched; the agent binary is not rebuilt. The command this ADR generates is **rendered
in a browser to an authenticated admin** and travels no further unless that admin sends it. The
distinction is the one §7 itself draws: *"a report is data flowing into a server, a policy is
instruction flowing into a process running as root."* An instruction flowing into a *person* is a
third thing, and it is the thing lazyit already does — [[0084-update-awareness-and-guided-update]] §4
is exactly this shape one layer up (*"the in-app ADMIN action is **enqueue + show the command**"*),
and the "Add a server" wizard is exactly this shape for the install.

**The test this ADR holds itself to:** if every lazyit server in the world were compromised tomorrow,
what could it make a root agent do? Under Shape A or C: replace its binary. Under Shape B: exactly
what it can do today — return a policy of booleans and globs, and render HTML to a logged-in admin.
The worst case does not move. That is the whole argument, and it is why this shape was chosen.

### §2 — #1203 is a hard prerequisite, not a caveat

**Until served binaries carry the real version, this feature computes nothing.** Every Docker-served
agent reports `agentVersion: "dev"`; `dev` is unparseable; both helpers are fail-soft; so the honest
output of the fleet view on today's code is *"245 agents, version unknown, 0 behind"* — which is
correct, useless, and exactly what it should say rather than guessing.

So: **#1203 lands first.** This ADR does not design around it, does not add a fallback that infers a
version from something else, and does not treat `dev` as a version. It depends on it.

**And #1203 is not instantaneous either, which this ADR states rather than discovers.** #1203 fixes
what the *release build* stamps; **already-installed agents keep reporting `dev` until they are
re-installed from an image that carries the fix.** The consequence is worth naming plainly:

> **The first update is the one lazyit cannot help you with.** An estate arrives at this feature with
> every agent unversioned, and each host becomes visible in the fleet view only after it has been
> re-installed once. The view is therefore honest about a third bucket (§3) from day one, and it
> becomes useful as the estate turns over — permanently, from that point on.

`dev` must remain a first-class, fail-soft value regardless: an agent compiled from a source checkout
legitimately has no tag, and nagging a developer's own build is the noise ADR-0083's #907 amendment
deliberately designed out.

### §3 — "Behind" is defined once, by the helpers that already exist

There is exactly one notion of version ordering in this codebase and this ADR adds none. Both
questions are answered by `packages/shared/src/utils/semver.ts`, unchanged:

| Bucket | Predicate | Meaning |
| --- | --- | --- |
| **Behind** | `isNewerVersion(serverVersion, node.agentVersion)` | the server is strictly newer — any MAJOR/MINOR/PATCH gap |
| **A MAJOR behind** | `isMajorBehind(node.agentVersion, serverVersion)` | the existing #907 contract-break tier |
| **Version unknown** | neither, because a side did not parse | `dev`, unstamped, or an odd tag |
| **Current** | neither, because both parsed and the agent is not behind | up to date (or ahead — a rebuilt host mid-upgrade) |

Three decisions follow, and they are decisions rather than defaults:

- **The fail-soft posture stays exactly as it is.** Either side unparseable ⇒ never behind. It is not
  loosened, not special-cased for `dev`, and no "assume behind when unknown" heuristic is added. An
  update prompt on a guess is worse than silence, and the fail-soft rule is load-bearing in three
  other places (`isNewerVersion`, `countVersionsBehind`, `agentSkew`).
- **But "unknown" becomes visible instead of silent.** Today the #907 badge simply renders nothing, so
  an unstamped agent is indistinguishable from a current one on every surface. The fleet view shows
  **"version unknown"** as its own bucket with its own count. This changes no helper and no
  comparison — it changes only whether the operator is told that lazyit does not know. Given §2, this
  is the bucket most estates will start in, and hiding it would make the whole view a lie.
- **The nag tier stays MAJOR-only; the table shows everything.** The #907 badge, and anything that
  produces a count, a colour or an interruption, keeps `isMajorBehind` — ADR-0083's reasoning holds
  verbatim (MAJOR is the "not one-click-safe" boundary; PATCH/MINOR drift is expected and nagging on
  it is noise). The *fleet view itself* lists the full distribution, because **a table an admin
  navigated to is not a nag**. That line is the same one [[0084-update-awareness-and-guided-update]]
  §5 draws between the badge and the card.

### §4 — The fleet view: this ADR absorbs epic #1146 item 1

**Absorbed, explicitly, so two issues do not both believe they own this screen.** Item 1 asked *"how
many agents do I have, on what versions, who hasn't checked in, and who is degraded?"* — which is the
same query, over the same rows, as *"who is behind"*. Shipping them separately would produce two
surfaces answering overlapping questions, and the version column would be the join between them.

It is also the better product in one direction only: item 1 without this ADR is a report an operator
cannot act on, and this ADR without item 1 is an action list with no context for the estate it acts
on. **The implementation issue cut from this ADR closes item 1**; the epic line should be struck when
it is opened.

What is in scope, all of it from data the server already holds:

- **Agent version per node** (`InfraNode.agentVersion`), bucketed per §3, with the distribution
  summarised above the table.
- **Liveness** — `lastReportedAt` and the OFFLINE state the staleness sweeper already maintains
  ([[0074-server-reporting-agent]] §4), plus `ServiceAccount.lastUsedAt` for a host that has an
  identity but has never reported.
- **Degraded** — item 1's own example, *"web-03: reporting unprivileged — no serial/model"*, from the
  contract-v2 `diagnostics` block already on the report.
- **The command**, per host (§5).

What is **not** absorbed: epic item 2 (Retire, a lifecycle change), item 4 (software watchlist) and
item 8 (notification routing) stay their own items. Retire in particular is adjacent — a decommissioned
host should not sit in a fleet view forever — but it is an enum change and a new action, and folding
it in would make this ADR about something else.

### §5 — The command: one builder, both platforms, the right flags

**`agent-install-commands.ts` is reused, not duplicated** — and reuse here has a specific meaning,
because the module currently lives in a route-private `_components/` folder next to the wizard that
was its only caller.

- **The module is lifted to a web-internal shared location** (`apps/web/lib/agent/…`), **with its
  test**, and both the wizard and the fleet view import it. It does **not** move to `@lazyit/shared`:
  it builds strings about two files this repo *serves*, and its test asserts them against
  `apps/web/public/install.sh` and `install.ps1` as actually served. That test is the thing that makes
  the module trustworthy, and it belongs in the app that ships those files.
- **Both platforms, chosen from evidence.** The per-host command is built for the reported
  `AgentOsFamily` (#1138) — the platform discriminator the agent already sends on every report and the
  one thing every downstream consumer was given to branch on. A node whose family is unknown or is
  neither `linux` nor `windows` shows **both** commands with a note, never a guess: handing a
  PowerShell line to a Debian box is the wizard bug #1168 already fixed once.
- **The flags ride for free, and that is the point of reusing this module.** `insecureHttp(origin)`
  already appends `--allow-insecure-http` / `-AllowInsecureHttp` for a plain-http origin and never for
  https ([[0087-plain-http-lan-deployment-axis]] instances are first-class, #1190), and checksum
  verification is required by default since #1190 with no flag to pass. A hand-rolled second builder
  would get exactly this wrong, silently, on the LAN installs that are hardest to test.
- **Origin comes from the browser**, as it does in the wizard — the instance the admin is already
  talking to over that same channel.
- The read-only **`lazyit-agent test`** line (`agentDiagnosticsCommand`) rides along as the
  after-the-fact verification, per platform, with its existing Windows elevation note.

`AgentOsFamily` lives inside the stored `specs` blob rather than on the list row (`specs` is
deliberately off list rows, #1135). The fleet read therefore **projects that one string server-side**
and puts it on the row — the [[0090-ipam-validated-ip]] display-only-read-field mold, computed per
read, no migration, no column, never a gate. *ponytail:* promote it to a real column only if an estate
ever makes that projection the slow part of the read.

### §6 — The token, stated rather than designed around

The generated command **carries no token**, and this is a decision, not a gap.

The server cannot re-emit an installed host's token (§Context): only the hash is stored. So the honest
options are to mint a fresh service-account token per host — 245 tokens for an update — or to let the
credential come from where the operator already keeps it. This ADR chooses the latter:

- **The emitted update command names the environment variable, not a value**: `LAZYIT_TOKEN` on Linux
  (`install.sh:204`, and `install.sh`'s own header already recommends it *"KEEPING THE TOKEN OUT OF
  `ps` AND SHELL HISTORY (#1137)"*), `$env:LAZYIT_TOKEN` on Windows (`install.ps1:328`). Both
  installers already read it. This is strictly better than a token in a copy buffer, and it is the
  form config management wants anyway — Ansible has a vault, GPO/Intune have their own credential
  store, and lazyit generating a playbook with a live root-capable credential baked into it would be
  the wrong artifact regardless of ergonomics.
- **For a single host by hand**, an admin who no longer holds the token uses the path that already
  exists: rotate or mint a service-account token, which shows the plaintext once, exactly as the "Add
  a server" wizard does today. The fleet view links there rather than reimplementing it.
- **A `--keep-token` / reuse-the-installed-config mode on both installers** would make the update
  command fully self-contained — the token is already on disk in `/etc/lazyit-agent/config`, ACL'd, and
  the installer is about to rewrite that same file. It is a real ergonomic win and it is an
  **installer** change, not an agent or protocol change, so it does not touch either red line. It is
  **not decided here**: it changes credential handling in the file that runs as root, which deserves
  its own issue and a CEO ruling (§Decisions needed).

#### §6 amendment (2026-08-04, #1208 / #1207) — the deferred installer mode landed and replaced the above

The third bullet's deferred mode shipped as `--upgrade` / `-Upgrade`, and it does not merely improve
the ergonomics of the emitted command — **it removes a defect the first two bullets contained.**

- **`--url` was a fleet-wide re-pin, not a convenience.** The command carried `--url <browser origin>`,
  and `LAZYIT_URL` is a key the installer **owns and rewrites**. In the `lan` mode of
  [[0087-plain-http-lan-deployment-axis]] the instance answers on every Host it is reached by, so one
  paste across an estate silently repointed every host at whichever address one admin's browser was
  on — while the Manual promised that a host's configuration is *merged, not replaced*. `--upgrade`
  reads `LAZYIT_URL` and `LAZYIT_CA_FILE` back off `/etc/lazyit-agent/config`, so the command cannot
  repoint anything. The origin survives only as **where the script is fetched from**.
- **Naming `LAZYIT_TOKEN` is now wrong, not merely unnecessary.** `--upgrade` inherits `--keep-token`'s
  refusal to share a run with any other credential source, so an exported `LAZYIT_TOKEN` is a **hard
  error**. The old advice would break the command it accompanied. `sudo -E` goes with it: it existed
  only to carry that variable across sudo's environment reset.
- **The lost-token route was dangerous.** *"Rotate or mint one"* — `ServiceAccounts.rotate()`
  **invalidates the existing secret**, so on a fleet sharing one `infra:report` account (the shape this
  ADR's own §7 reasoning assumes) it silently stops every other host reporting. The host already holds
  a working credential, so `--upgrade` is the answer; mint is named only for a host with **no readable
  config**, with rotation's blast radius stated explicitly.

**The emitted commands are therefore, verbatim and identical on every host:**

```sh
curl -fsSL <origin>/install.sh | sudo sh -s -- --upgrade
```

```powershell
& ([scriptblock]::Create((irm <origin>/install.ps1))) -Upgrade
```

The `--allow-insecure-http` / `-AllowInsecureHttp` opt-in still rides on a plain-http origin (#1190),
and #1208's final resolution made that **load-bearing rather than merely harmless**: the opt-in is
explicitly **not inherited** across an upgrade. A host installed over cleartext carries
`LAZYIT_URL=http://…` in its config, `--upgrade` re-uses that URL, and the plain-http gate bites on
the *resolved* URL whatever supplied it — so the run is refused unless the opt-in is passed again,
with `$URL_SOURCE` naming the config file so the refusal never mentions a `--url` the operator did not
pass. Letting the file answer "cleartext is acceptable" on the operator's behalf would be the same
fail-open #1190 closed, one input over. Dropping the flag from the generated update command would
therefore hand every `lan` operator a command that hard-stops on paste; `insecureHttp(origin)` keys
the update command for exactly that reason, and `install-commands.test.ts` asserts both halves.

It is still **not** a re-pin: it is a per-run decision rather than a config key the installer writes,
so the string stays identical across hosts for a given origin.

**The one caveat, pre-existing and unchanged:** `--upgrade` re-uses the host's `LAZYIT_CA_FILE` for the
agent's own traffic, but the `curl`/`irm` that fetches the script runs before any config is read — so a
host behind an internal CA still needs that CA in its system trust store. The install command had the
same first hop. Stated in the dialog and in the Manual rather than left to be discovered.

**The install (first-time) command is unchanged** — it still carries `--url` and a token, because there
is no config on the host to read.

### §7 — Config-management handoff: the command is the interface

**The generated command is the whole integration surface.** lazyit does not generate Ansible
playbooks, GPO startup scripts or Intune packages, and will not: those are promises about systems this
repo cannot test, they rot silently, and the operator who runs Ansible already knows how to wrap a
shell command better than a generator would guess.

What lazyit owes instead is the guarantee that makes the command safe to hand to a machine — that
**re-running the installer is idempotent and non-destructive**, which is already true and already the
documented upgrade path on both platforms:

- It **re-verifies the checksum** on every run and a mismatch is always fatal (#1190).
- It **runs `lazyit-agent --help` before arming anything**, and on failure removes the binary and
  leaves the host as it was found ([[0074-server-reporting-agent]] §6 amendment, #1137) — so a bad
  artifact fails at install rather than becoming a host that looks installed and silently never
  reports.
- It **merges the existing config rather than replacing it**, carrying every unknown `LAZYIT_*` key
  forward — which is what preserves the host owner's `LAZYIT_COLLECT_*=false` vetoes across an upgrade
  ([[0074-server-reporting-agent]] §7 amendment, #1137). A fleet update must never silently re-enable
  a collector a host owner turned off, and it does not.
- The systemd unit / scheduled task is rewritten to the same shape it already had; the node keeps its
  identity, because identity is `(reportingSource, externalId)` and not the binary
  ([[0074-server-reporting-agent]] §2/§3). **One host = one node, across an update.**
- Running it on a host that is already current is a no-op re-install, not an error.

So the handoff is: **copy one command for one host, or copy the whole behind-set and feed it to
whatever already runs commands on those hosts.** v1 ships per-host copy and a bulk copy of the
generated commands for the current filter. Nothing more — no push button, no scheduler, no inventory
export format, because each of those is a different product and the first two are Shape C wearing a
disguise.

### §8 — UI posture, and where "agents behind" is allowed to speak

Posture follows [[0084-update-awareness-and-guided-update]] §5 exactly, because it is the same
operator and the same discipline:

- **Only-when-actionable.** The update affordance renders **only** for a host that is genuinely
  behind. No dead disabled button on a current host, no "you're up to date, but here's the command
  anyway" — a calm current state instead.
- **No nagging.** No global banner, no login-time interrupt, no modal. The fleet view is a place the
  admin navigates to.
- **Any badge or count is MAJOR-only** (§3), reusing the shipped #907 signal rather than minting a
  second, louder one.
- The distribution reads as a summary, not an alarm: *"245 agents · 12 a MAJOR behind · 31 behind ·
  180 version unknown · 22 not reporting"*.

**Routing decision: in-app only in v1. No new notification type, no email.** Three reasons, all of
which are existing decisions rather than taste:

1. The email allowlist (`EMAIL_NOTIFICATION_TYPES`, [[0079-instance-smtp-outbound-email]]) is a
   curated flat list where **every addition has been an explicit CEO opt-in**. It is deliberately not
   a rules engine, and this ADR does not get to add to it by implication.
2. **The admin is already being told.** `update.available` fires when the *instance* is behind — and
   agents fall behind precisely *because* the instance moved forward. A second email about the same
   underlying event is the re-nag [[0084-update-awareness-and-guided-update]] §2's de-dupe discipline
   exists to prevent.
3. **Per-host email on a 245-host estate is the anti-pattern by construction** — the same reasoning
   epic item 8 already records for `infra.agent_offline` broadcasts (*"a bell nobody trusts is worse
   than no bell"*).

One narrow fork is worth putting to the CEO rather than deciding unilaterally: whether the **existing**
`update.available` email should gain **one aggregate line** ("…and 12 agents are a MAJOR behind"). It
creates no type, no schedule and no per-host traffic, and it reaches the admin at the exact moment
they are already reading about a version gap. It also changes the content of a shipped email, which is
the CEO's call (§Decisions needed).

### §9 — The canary condition is withdrawn

An earlier CEO requirement — **that the lazyit host itself run the agent and be detectable, so the
instance is its own canary** — is **withdrawn**, and the reason is recorded here so it is not
resurrected later as an unexplained line in a backlog.

- **It was a safety gate for unattended execution.** Its purpose was that a fleet-wide automatic
  update would hit the lazyit host first, where the blast radius is observable. **Shape B has no
  unattended execution**, so the gate guards nothing: there is no automatic rollout to canary, and the
  operator updates hosts in whatever order they choose, one command at a time.
- **Its detection heuristic was fragile anyway.** Identifying "this node is the lazyit host" meant
  matching container names in the reported container list — a string match against a deployment detail
  an operator can rename freely.
- **And it was unilaterally suppressible, by design.** A host owner setting
  `LAZYIT_COLLECT_CONTAINERS=false` removes the evidence, and **the server cannot override that**:
  [[0074-server-reporting-agent]] §7's first hard rule is *"local config may VETO, never widen"*, and
  a local `true` is simply not carried. A safety gate that the thing being guarded can switch off is
  not a safety gate.

If Shape C is ever reopened (§Considered options), a canary requirement returns to the table **on its
own merits and with a detection mechanism that is not vetoable** — not as an inherited condition.

### §10 — Upgrade path (workflow rule #8)

**There is no migration, and no schema change of any kind.** Every field this ADR reads already
exists: `InfraNode.agentVersion` (#907's migration), `lastReportedAt`, the node state, the
`diagnostics` block, `ServiceAccount.lastUsedAt`, and `AgentOsFamily` inside `specs`. The entire
feature is a read plus a pure string builder.

What an operator sees change, in order:

1. **At the moment of the upgrade: nothing moves.** A new read-only surface appears. No existing page,
   badge, email or agent behaviour changes. Nothing on any host is touched.
2. **The fleet view starts mostly "version unknown", and says so** (§2). On an estate whose agents
   predate #1203, that is the truthful answer, and it is why the bucket exists.
3. **It fills in as hosts are re-installed.** Each host that runs the command once acquires a stamped
   version and moves into a real bucket. No backfill, no maintenance window — the same lazy-fill
   posture [[0093-chassis-routing-and-asset-adoption]] §8 took for `chassis`.
4. **Nothing regresses if the operator ignores it entirely.** The agents keep reporting, the CMDB keeps
   filling, the #907 badge behaves exactly as before. This feature adds an answer; it removes no
   behaviour and gates nothing.
5. **A host that has not upgraded is never disadvantaged.** An older agent that reports `dev` is
   "unknown", never "behind", never flagged, never nudged — read-tolerant of legacy data, enforcing
   nothing on write, because it does not write.

### §11 — What this ADR deliberately does NOT change

- **The agent binary.** Not rebuilt, not re-flashed, no new subcommand, no new config key. A fleet on
  today's binary gets the whole feature.
- **The report contract and the ack.** `AgentReportAckSchema` gains **no** `agentUpdate` field, and
  `AgentPolicySchema` stays a `strictObject` over booleans, integers and globs. #1138's loose report
  root is not spent.
- **`ProtectSystem=full` and the rest of the Linux sandbox.** Untouched. This ADR exists partly so it
  stays untouched.
- **The #907 badge and its MAJOR-only semantics.** Reused as-is; not widened to MINOR/PATCH, not
  turned into a gate. [[0083-versioning-and-releases]]'s *warn/hint-only, never a gate* posture holds.
- **The installers**, in v1 — beyond the `--keep-token` question deferred to a CEO ruling (§6). No
  flag is added, no default changes.
- **[[0084-update-awareness-and-guided-update]], [[0083-versioning-and-releases]] and
  [[0074-server-reporting-agent]]** are not amended by this record. Where their text bears on this
  decision it is quoted, not edited.

## Consequences

- **Positive.** The operator's real question gets an answer for the first time, from data that has
  been sitting in a column since #907 with nothing reading it. Both red lines are cleared **by
  construction** rather than by policy — there is no code path to disable, no flag to get wrong, and
  the compromised-server worst case does not move a millimetre. It costs **no migration, no agent
  change, no contract change**, and it closes epic item 1 in the same surface. Reusing
  `agent-install-commands.ts` means the fleet view cannot drift from the wizard on the flags that are
  easiest to get silently wrong (#1190's http opt-in, the Windows script-block form).
- **Negative / trade-offs (accepted).**
  - **It does not update anything.** On a 245-host estate the operator still runs 245 commands, or
    wires one into their config management. That is the deliberate trade: the epic's own framing was
    that copy-paste "does not scale past ~15 hosts", and this ADR answers the *knowing* half now and
    leaves the *doing* half to Shape C's reopening criteria.
  - **It is inert until #1203 ships**, and partially inert for one turnover cycle after that (§2). A
    reviewer looking at this feature the week it merges will see a page full of "unknown".
  - **The token is not in the command** (§6), so the paste path is two steps for an admin who no
    longer holds one. Honest, and better than 245 fresh tokens.
  - **The os-family projection reads `specs`** on the fleet query. Bounded at a few hundred rows,
    accepted, with the ponytail recorded in §5.
  - **Deciding "in-app only" means a stale fleet is only visible to someone who looks.** Accepted:
    the alternative is a per-host email channel on a 245-host estate, and the aggregate-line fork
    (§8) is the cheap middle if the CEO wants one.

## Decisions resolved — 2026-08-04

All three questions were put to the CEO and **approved as recommended**. They are settled; changing
any of them supersedes this record rather than amending it in passing.

1. **The existing `update.available` email carries one aggregate agent line** ("…and 12 agents are a
   MAJOR behind"). One line, no new notification type, no new schedule, no per-host mail — it reaches
   the admin while they are already reading about a version gap. §8's in-app-only posture is amended
   by exactly this one line and nothing else; the per-host notification anti-pattern epic item 8
   names stays rejected.
2. **`--keep-token` / reuse-the-installed-config ships as a follow-up issue**, not folded in here. It
   is what makes the generated command genuinely copy-paste rather than copy-paste-plus-find-the-token,
   because the server structurally cannot re-emit an installed host's secret (only `tokenHash` and
   `tokenPrefix` are stored). It is an installer change touching credential handling in a file that
   runs as root, so it gets its own issue, its own review and its own tests.
3. **ADR-0084's "No auto-apply, ever" sentence is scoped explicitly** to the server's own update, with
   a pointer to this record for the agent axis. A one-line amendment to that ADR, in its own change.
   Nothing in this record depends on it — §1 reads the sentence at face value and stays inside it
   either way — but the next proposal in this area would otherwise ask the same question again.

## Links

- Issue: #1204 · epic #1146 (absorbs item 1; declines item 3 as written) · **#1203 (hard
  prerequisite)**
- ADRs: [[0084-update-awareness-and-guided-update]] (the shape this mirrors, and the red line it stays
  inside) · [[0074-server-reporting-agent]] (§6 instance-served binaries, §7 the agent + the
  no-server-pushed-execution rule, §8 the security model) · [[0083-versioning-and-releases]] (+ the
  #907 distributed-binary version handshake, `isMajorBehind`) ·
  [[0093-chassis-routing-and-asset-adoption]] (the lazy-fill upgrade posture) ·
  [[0090-ipam-validated-ip]] (the display-only computed read-field mold) ·
  [[0079-instance-smtp-outbound-email]] (the email allowlist this ADR does not add to) ·
  [[0087-plain-http-lan-deployment-axis]] (why the http opt-in flag exists) ·
  [[0077-ledger-design-language-frontend-refactor]] (the UI language) ·
  [[0056-in-app-notification-bell]] (only-when-non-zero badges)
- Entities: [[infra-node]] · [[service-account]]
- Prior issues: #907 (the badge this makes computable) · #1137 (the sandbox, the config merge, the
  token-out-of-`ps` guidance) · #1138 (the loose report root and the `AgentOsFamily` discriminator) ·
  #1144 (the Windows collector) · #1168 (the wizard's per-platform commands) · #1190 (checksum
  required by default, the http opt-in) · #1135 (`specs` off list rows)
