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
 * WINDOWS PATHS ARE WRITTEN `\\`. In a TypeScript string `".\install.ps1"` is `.install.ps1` — `\i`
 * is not an escape sequence, so the backslash is dropped silently. Every literal below doubles them
 * and the test asserts the result, because this is a mistake that reads as correct.
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
 * That second step runs the downloaded file through `[scriptblock]::Create` rather than as
 * `.\install.ps1`. Invoking a `.ps1` file is subject to the host's execution policy — `Restricted` by
 * default on Windows client editions — while a script block built in memory is not. It is not a
 * second spelling of the command: it is the form the installer's own header prescribes, sourced from
 * disk instead of from the network.
 */
export function agentManualInstallCommands(
  platform: AgentPlatform,
  origin: string,
  token: string,
): string[] {
  if (platform === "windows") {
    return [
      `irm ${origin}/install.ps1 -OutFile .\\install.ps1`,
      `& ([scriptblock]::Create((Get-Content -Raw .\\install.ps1))) -Url ${origin} -Token ${token}`,
    ];
  }
  return [
    `curl -fsSL -H "Authorization: Bearer ${token}" "${origin}/api/agent/download?arch=x64" -o lazyit-agent`,
    "chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/",
    `sudo install -d -m 700 /etc/lazyit-agent && printf 'LAZYIT_URL=%s\\nLAZYIT_TOKEN=%s\\n' "${origin}" "${token}" | sudo tee /etc/lazyit-agent/config >/dev/null && sudo chmod 600 /etc/lazyit-agent/config`,
    "sudo lazyit-agent report --once --force",
  ];
}

/**
 * The read-only check to run on the host afterwards — it sends nothing and changes nothing.
 *
 * Linux gets the bare name: install.sh puts the binary in `/usr/local/bin`, which is on PATH.
 *
 * Windows gets the ABSOLUTE path, because install.ps1 installs under `%ProgramFiles%` and never adds
 * that directory to PATH — the bare `lazyit-agent test` the Manual documents raises
 * CommandNotFoundException there today. That is issue #1167, still open. When it lands, the bare name
 * will ALSO work in a new shell; the absolute form printed here keeps working either way, so this
 * command needs no revision when it does.
 */
export function agentDiagnosticsCommand(platform: AgentPlatform): string {
  return platform === "windows"
    ? `& ${WINDOWS_AGENT_EXE} test`
    : "sudo lazyit-agent test";
}
