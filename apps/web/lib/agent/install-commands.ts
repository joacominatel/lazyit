/**
 * The exact commands lazyit hands an operator for a host, per platform (issues #1168 and #1207).
 *
 * Pure and separate from the component for the same reason `tray-selection.ts` is: what the UI
 * prints is a promise about two installers it does not contain, and a promise is not something a
 * component can be held to. `install-commands.test.ts` asserts these strings against
 * `apps/web/public/install.sh` and `apps/web/public/install.ps1` as they are actually served.
 *
 * IT LIVES IN `lib/` AND NOT IN `@lazyit/shared` (ADR-0094 §5). It was route-private under the
 * topology wizard's `_components/` until the agent fleet view needed the same strings; two callers
 * make it web-internal shared code, and there is exactly ONE builder so the fleet view can never
 * drift from the wizard on the flags that are hardest to test (the plain-http opt-in below). It does
 * not go further out to the shared package because its test — the thing that makes it trustworthy —
 * reads the two installer files THIS app serves off disk, and that test belongs where they ship.
 *
 * The wizard used to emit the Linux one-liner and nothing else. The agent has been cross-platform
 * since ADR-0074's Windows amendment (#1144) and the Manual has documented the PowerShell form since
 * then — the UI was the last surface that did not know Windows exists, which is where a real operator
 * found it, holding a once-only token that had just been minted for a host the command cannot run on.
 *
 * WINDOWS PATHS ARE WRITTEN `\\`. In a TypeScript string `"$env:TEMP\lazyit-install.ps1"` is
 * `$env:TEMPlazyit-install.ps1` — `\l` is not an escape sequence, so the backslash is dropped
 * silently. Every literal below doubles them and the test asserts the result, because this is a
 * mistake that reads as correct.
 */

/** The platforms an agent binary is actually built for (ADR-0074 §6; `apps/agent/package.json`). */
export const AGENT_PLATFORMS = ["linux", "windows"] as const;

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/**
 * `$env:ProgramFiles\lazyit-agent\lazyit-agent.exe`, quoted for the space in "Program Files".
 *
 * The installer's own spelling — `Join-Path $env:ProgramFiles 'lazyit-agent'` — rather than a
 * hard-coded `C:\Program Files`, so it still names the right file on a host whose ProgramFiles is
 * relocated or redirected.
 */
const WINDOWS_AGENT_EXE = '"$env:ProgramFiles\\lazyit-agent\\lazyit-agent.exe"';

/**
 * Where the inspect-first path SAVES the installer, quoted for a `%TEMP%` under a profile whose name
 * has a space in it.
 *
 * Explicit, and deliberately not the working directory: an elevated PowerShell — the one the wizard
 * just told the operator to open — starts in `C:\Windows\System32`, so a bare `-OutFile .\install.ps1`
 * writes a freshly downloaded script into the system directory. `%TEMP%` is writable by the operator
 * who is already elevated, and the name is prefixed so the download does not silently overwrite an
 * unrelated `install.ps1` already sitting there.
 */
const WINDOWS_INSTALLER_COPY = '"$env:TEMP\\lazyit-install.ps1"';

/**
 * `true` for a plain-http origin. Since #1190 both installers REFUSE a cleartext http URL unless
 * the operator opts in explicitly (`--allow-insecure-http` / `-AllowInsecureHttp`) — the exposure
 * is real: the binary that will run as root or SYSTEM, and the SA token on every later report. The
 * wizard fills the origin in from the instance the operator is ALREADY browsing over that same
 * channel, so the decision was made when the instance was deployed on http (`lan` mode) — a pasted
 * command that hard-stops there would be a broken promise, not a second chance to decide. The flag
 * therefore rides every command built for an http origin, and never one built for https.
 */
function insecureHttp(origin: string): boolean {
  return /^http:\/\//i.test(origin);
}

/** A step of the inspect-first path: its `infra.wizard` message key, and the command it labels. */
export type AgentManualStep = {
  /**
   * The catalog key for this step's label, relative to the `infra.wizard` namespace.
   *
   * The label and the command are ONE object on purpose. They used to be two positionally-indexed
   * arrays — the labels read out of the catalog in the component, the commands built here — and
   * nothing held index N of one to index N of the other, so an edit could add a step to one side
   * only and every test still passed. `install-commands.test.ts` now asserts these keys
   * against the `stepN` keys BOTH locale catalogs actually ship, in order.
   */
  labelKey:
    | `manual.linux.step${1 | 2 | 3 | 4}`
    | `manual.windows.step${1 | 2}`;
  command: string;
};

/** The per-command choices the wizard's step 2 exposes (#1225). */
export type AgentInstallOptions = {
  /**
   * ADR-0095 §8's host-owner veto: this host never reports its guests. Appends `--no-hypervisor`
   * (Linux) / `-NoHypervisor` (Windows), which writes `LAZYIT_COLLECT_HYPERVISOR=false` into the
   * host's own config — a local setting the server's policy can never widen, preserved across
   * re-runs like every other `LAZYIT_COLLECT_*` key. Default absent: collection is the default,
   * and detection is the agent's own re-evaluated-every-tick behavior, never the installer's.
   */
  noHypervisor?: boolean;
};

/**
 * The command to paste, with the real instance origin and the real token already in it.
 *
 * TWO LINES SINCE #1225, because the token left argv. `--token <secret>` sat in
 * `/proc/<pid>/cmdline` — world-readable on Linux — for the whole install, and in shell history
 * after it; install.sh's own header (#1137) has always named `LAZYIT_TOKEN` as the safe channel,
 * and the wizard was the last surface still printing the argv form. So the first line hands the
 * secret to the environment and the second runs the installer without it:
 *
 *  - **Linux** is `export LAZYIT_TOKEN=…` + `curl … | sudo -E sh`. The `-E` is load-bearing: sudo
 *    resets the environment, so without it the exported token never reaches the installer
 *    (`TOKEN="${TOKEN:-${LAZYIT_TOKEN:-}}"` — asserted against the served script by the test). It
 *    cannot be a one-line prefix assignment: `LAZYIT_TOKEN=x curl … | sudo -E sh` scopes the
 *    variable to `curl` alone, and the installer would die asking for a token. This exact
 *    export + `sudo -E` pipe is the form the Manual taught for the pre-#1208 update command — a
 *    documented channel, not a new invention.
 *  - **Windows** is `$env:LAZYIT_TOKEN = '…'` + the SCRIPT-BLOCK form, still not `irm … | iex`,
 *    because the pipe form runs the installer with no arguments at all: `-Url` never reaches it and
 *    it dies asking for it. install.ps1's own `.EXAMPLE` documents the `$env:` form, and the
 *    installer falls back to it when `-Token` is absent. No sudo hop exists here — the elevated
 *    PowerShell the wizard already requires is the same session that runs the script block.
 *
 * The token still lands in the pasted line and therefore in shell history — only `--token-file`
 * avoids that, and the Manual says so. What this form removes is the `ps` window: an unprivileged
 * user polling the process list during the install no longer collects a live `infra:report` token.
 */
export function agentInstallCommand(
  platform: AgentPlatform,
  origin: string,
  token: string,
  options: AgentInstallOptions = {},
): string {
  if (platform === "windows") {
    const optIn = insecureHttp(origin) ? " -AllowInsecureHttp" : "";
    const veto = options.noHypervisor ? " -NoHypervisor" : "";
    return `$env:LAZYIT_TOKEN = '${token}'\n& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Url ${origin}${optIn}${veto}`;
  }
  const optIn = insecureHttp(origin) ? " --allow-insecure-http" : "";
  const veto = options.noHypervisor ? " --no-hypervisor" : "";
  return `export LAZYIT_TOKEN='${token}'\ncurl -fsSL ${origin}/install.sh | sudo -E sh -s -- --url ${origin}${optIn}${veto}`;
}

/**
 * The command that brings ONE ALREADY-INSTALLED host up to the instance's build (ADR-0094 §5/§6).
 *
 * It is `--upgrade` / `-Upgrade` and NOTHING ELSE (#1208), and every argument that is absent is
 * absent on purpose.
 *
 * **WHY IT CARRIES NO `--url`.** It used to. `LAZYIT_URL` is a key the installer OWNS and REWRITES
 * on every run, and the origin in a generated command is whatever host header the admin's browser
 * happened to reach this instance on. In the `lan` deployment mode of ADR-0087 the instance answers
 * on every address it is reached by, so one paste across forty hosts silently re-pinned the whole
 * estate at one admin's URL — and it contradicted the Manual's own promise that a host's
 * configuration is *merged, not replaced*. `--upgrade` reads `LAZYIT_URL` back off
 * `/etc/lazyit-agent/config` instead, so the command cannot repoint anything. The origin below
 * survives only as WHERE THE SCRIPT IS FETCHED FROM; it is never written to the host.
 *
 * **WHY IT CARRIES NO TOKEN, AND WHY NAMING `LAZYIT_TOKEN` HERE WOULD NOW BE A BUG.** The server
 * structurally cannot re-emit an installed host's secret — only `tokenHash`/`tokenPrefix` are stored
 * (ADR-0094 §6). This used to be answered by telling the operator to export `LAZYIT_TOKEN` and
 * carrying `sudo -E` to get it past sudo's environment reset. `--upgrade` authenticates with the
 * token already in the host's own config file, which the installer wrote there itself at `0600`. It
 * also inherits `--keep-token`'s refusal to share a run with any other credential source, so
 * `LAZYIT_TOKEN` set in the environment is now a HARD ERROR rather than a fallback: the old advice
 * would break the very command it accompanied. `sudo -E` goes with it — there is no longer an
 * environment variable worth preserving across sudo.
 *
 * **WHY IT CARRIES NO `--ca-file`.** Same reason as the URL: `LAZYIT_CA_FILE` comes back off the
 * host's config. One caveat is real and pre-existing, and the UI and the Manual both state it — the
 * `curl`/`irm` that fetches THIS SCRIPT runs before any of that, so a host behind an internal CA
 * still needs that CA in its system trust store for the first hop. That was true of the install
 * command too; `--upgrade` neither fixes nor worsens it.
 *
 * The result is one string per platform, IDENTICAL ON EVERY HOST, which is what makes the bulk
 * handoff of ADR-0094 §7 a two-line artifact rather than a generated per-host inventory.
 *
 * Everything else about re-running is already true and is why this is safe to hand to a machine:
 * the checksum is re-verified on every run and a mismatch is fatal (#1190), the installer runs
 * `lazyit-agent --help` before arming anything and leaves the host as it found it on failure, it
 * MERGES the existing config rather than replacing it (so a host owner's `LAZYIT_COLLECT_*=false`
 * veto survives), and the node keeps its identity because identity is `(reportingSource, externalId)`
 * and not the binary. Re-running on a current host is a no-op.
 */
export function agentUpdateCommand(
  platform: AgentPlatform,
  origin: string,
): string {
  // The plain-http opt-in still rides, and it is NOT a re-pin: it is a per-run decision, not a
  // config key, so it is the same string on every host. It keys off the browser origin because that
  // is the only signal available — and on an ADR-0087 `lan` instance, the origin the admin is
  // browsing and the URL the host has on disk are the same plain-http address. Where they are not,
  // the run stops with the installer's own message rather than proceeding over cleartext.
  //
  // IT IS REQUIRED HERE, NOT OPTIONAL. #1208's final resolution made the opt-in NON-INHERITABLE: a
  // host installed over cleartext carries `LAZYIT_URL=http://…`, `--upgrade` re-uses it, and the
  // installers' plain-http gate bites on the RESOLVED url whatever supplied it — so an upgrade over
  // such a config is REFUSED unless the opt-in is passed again. Emitting the command without it
  // would hard-stop on paste on every `lan` instance. `install-commands.test.ts` pins both the
  // emitted string and the installers' non-inheritance comment.
  if (platform === "windows") {
    const optIn = insecureHttp(origin) ? " -AllowInsecureHttp" : "";
    return `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Upgrade${optIn}`;
  }
  const optIn = insecureHttp(origin) ? " --allow-insecure-http" : "";
  return `curl -fsSL ${origin}/install.sh | sudo sh -s -- --upgrade${optIn}`;
}

/**
 * The "I want to look at it first" path — ADR-0074 §8's inspect-before-running posture, which is what
 * a cautious admin does anyway.
 *
 * The two platforms answer it differently on purpose. On Linux the four steps ARE install.sh: download
 * the binary, place it, write `/etc/lazyit-agent/config`, send one report. On Windows the equivalent
 * would have to reproduce an ACL restricted to SYSTEM + Administrators and a registered scheduled task
 * — not four copy-pasteable lines, and a half-done version of it is worse than none. So Windows gets
 * the honest form of the same intent: download the installer, read it, then run it.
 *
 * That second step runs the saved file through `[scriptblock]::Create` rather than invoking it as a
 * `.ps1` file. Invoking a `.ps1` file is subject to the host's execution policy — `Restricted` by
 * default on Windows client editions — while a script block built in memory is not. It is not a
 * second spelling of the command: it is the form the installer's own header prescribes, sourced from
 * disk ({@link WINDOWS_INSTALLER_COPY}) instead of from the network.
 */
export function agentManualInstallSteps(
  platform: AgentPlatform,
  origin: string,
  token: string,
): AgentManualStep[] {
  if (platform === "windows") {
    return [
      {
        labelKey: "manual.windows.step1",
        command: `irm ${origin}/install.ps1 -OutFile ${WINDOWS_INSTALLER_COPY}`,
      },
      {
        labelKey: "manual.windows.step2",
        // The saved copy is still install.ps1, so an http origin needs the same opt-in here. The
        // Linux by-hand path below never runs install.sh — it has no gate to satisfy.
        command: `& ([scriptblock]::Create((Get-Content -Raw ${WINDOWS_INSTALLER_COPY}))) -Url ${origin} -Token ${token}${insecureHttp(origin) ? " -AllowInsecureHttp" : ""}`,
      },
    ];
  }
  return [
    {
      labelKey: "manual.linux.step1",
      command: `curl -fsSL -H "Authorization: Bearer ${token}" "${origin}/api/agent/download?arch=x64" -o lazyit-agent`,
    },
    {
      labelKey: "manual.linux.step2",
      command: "chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/",
    },
    {
      labelKey: "manual.linux.step3",
      command: `sudo install -d -m 700 /etc/lazyit-agent && printf 'LAZYIT_URL=%s\\nLAZYIT_TOKEN=%s\\n' "${origin}" "${token}" | sudo tee /etc/lazyit-agent/config >/dev/null && sudo chmod 600 /etc/lazyit-agent/config`,
    },
    {
      labelKey: "manual.linux.step4",
      command: "sudo lazyit-agent report --once --force",
    },
  ];
}

/**
 * The read-only check to run on the host afterwards — it sends nothing and changes nothing.
 *
 * BOTH FORMS NEED PRIVILEGE, and only one of them can carry it in the command. Linux has `sudo`:
 * pasted into an unprivileged shell it prompts, then works. Windows PowerShell 5.1 has no `sudo`, and
 * the in-command alternative — `Start-Process -Verb RunAs` — runs the check in a SECOND console whose
 * output is not in the shell the operator is reading, through two layers of command-line parsing
 * wrapped around a path with a space in it. So the requirement rides in the copy beside the command
 * instead (`infra.wizard.diagnostics.windowsNote`, asserted in both locales by this module's test).
 *
 * It is not cosmetic. install.ps1 ACLs the config file to SYSTEM + Administrators; the agent's
 * `readConfigFile` swallows a read error and returns an empty config; so an unelevated `test` reports
 * that no URL and no token are configured — on a host that installed perfectly.
 *
 * Linux gets the bare name: install.sh puts the binary in `/usr/local/bin`, which is on PATH.
 *
 * Windows gets the ABSOLUTE path. It was chosen when install.ps1 installed under `%ProgramFiles%` and
 * left that directory off PATH, so the bare `lazyit-agent test` the Manual documents raised
 * CommandNotFoundException (#1167) — chosen so it would need no revision when that was fixed. #1167
 * has since landed and the installer now writes the machine PATH, so the bare name resolves too, in a
 * NEW shell. THE ABSOLUTE FORM STAYS, and not out of inertia: the shell this command gets pasted into
 * is usually the elevated PowerShell the install just ran in, and a running process keeps the
 * environment block it started with — the one console guaranteed NOT to see the new entry is the one
 * the operator is holding. `windowsNote` says exactly that.
 */
export function agentDiagnosticsCommand(platform: AgentPlatform): string {
  return platform === "windows"
    ? `& ${WINDOWS_AGENT_EXE} test`
    : "sudo lazyit-agent test";
}
