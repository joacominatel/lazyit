/**
 * The exact commands the "Add a server" wizard hands an operator, per platform (issue #1168).
 *
 * Pure and separate from the component for the same reason `tray-selection.ts` is: what the wizard
 * prints is a promise about two installers it does not contain, and a promise is not something a
 * component can be held to. `agent-install-commands.test.ts` asserts these strings against
 * `apps/web/public/install.sh` and `apps/web/public/install.ps1` as they are actually served.
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

/** A step of the inspect-first path: its `infra.wizard` message key, and the command it labels. */
export type AgentManualStep = {
  /**
   * The catalog key for this step's label, relative to the `infra.wizard` namespace.
   *
   * The label and the command are ONE object on purpose. They used to be two positionally-indexed
   * arrays — the labels read out of the catalog in the component, the commands built here — and
   * nothing held index N of one to index N of the other, so an edit could add a step to one side
   * only and every test still passed. `agent-install-commands.test.ts` now asserts these keys
   * against the `stepN` keys BOTH locale catalogs actually ship, in order.
   */
  labelKey:
    | `manual.linux.step${1 | 2 | 3 | 4}`
    | `manual.windows.step${1 | 2}`;
  command: string;
};

/**
 * The one command to paste, with the real instance origin and the real token already in it.
 *
 * Linux is `curl … | sudo sh`, unchanged. Windows is the SCRIPT-BLOCK form and not `irm … | iex`,
 * because the pipe form runs the installer with no arguments at all: `-Url` and `-Token` never reach
 * it and it dies asking for them. install.ps1's `.EXAMPLE` and the Manual both say this; the wizard
 * now says it too.
 */
export function agentInstallCommand(
  platform: AgentPlatform,
  origin: string,
  token: string,
): string {
  if (platform === "windows") {
    return `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Url ${origin} -Token ${token}`;
  }
  return `curl -fsSL ${origin}/install.sh | sudo sh -s -- --url ${origin} --token ${token}`;
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
        command: `& ([scriptblock]::Create((Get-Content -Raw ${WINDOWS_INSTALLER_COPY}))) -Url ${origin} -Token ${token}`,
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
