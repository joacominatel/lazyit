/**
 * The commands the "Add a server" wizard hands an operator, held to the two installers they are
 * supposed to drive (issue #1168).
 *
 * The wizard emitted a `curl … | sh` one-liner and nothing else, so an operator standing at a Windows
 * host was given a command that cannot run there — at the exact moment they were holding a fresh,
 * once-only token. The Manual had carried the PowerShell form since #1144; the UI had not learned it.
 *
 * These are pure string builders, so this file can do the one thing prose could not: assert that what
 * the wizard prints is the same thing `install.sh` and `install.ps1` actually accept. Two tests read
 * the installers off disk and check the emitted switches against their real argument parsers, which
 * is what keeps this from becoming a sixth claim nobody re-checked.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  AGENT_PLATFORMS,
  agentDiagnosticsCommand,
  agentInstallCommand,
  agentManualInstallCommands,
} from "./agent-install-commands";

const ORIGIN = "https://lazyit.example.com";
const TOKEN = "lzit_sa_xxx";

/** `apps/web/public/<name>` — the installers this instance actually serves. */
function installerPath(name: string): string {
  return path.join(import.meta.dir, "..", "..", "..", "..", "..", "public", name);
}

describe("the platform set", () => {
  test("is exactly the two platforms an agent is built for", () => {
    // No macOS: ADR-0074 builds bun-linux-{x64,x64-baseline,arm64} and bun-windows-x64{,-baseline}
    // and nothing else, so offering a third choice would be an install that cannot be served.
    expect(AGENT_PLATFORMS).toEqual(["linux", "windows"]);
  });
});

describe("agentInstallCommand — Linux", () => {
  const command = agentInstallCommand("linux", ORIGIN, TOKEN);

  test("is the unchanged curl one-liner, with the real origin and the real token", () => {
    expect(command).toBe(
      `curl -fsSL ${ORIGIN}/install.sh | sudo sh -s -- --url ${ORIGIN} --token ${TOKEN}`,
    );
  });

  test("carries no PowerShell", () => {
    expect(command).not.toContain("powershell");
    expect(command).not.toContain("scriptblock");
  });
});

describe("agentInstallCommand — Windows", () => {
  const command = agentInstallCommand("windows", ORIGIN, TOKEN);

  test("is the script-block form, because the `irm | iex` pipe cannot take parameters", () => {
    // This is the whole reason the Windows one-liner does not read like its Linux sibling. `irm … |
    // iex` runs the script with NO arguments, so -Url and -Token never arrive and the installer dies
    // asking for them. install.ps1's own .EXAMPLE says so; so does the Manual.
    expect(command).toBe(
      `& ([scriptblock]::Create((irm ${ORIGIN}/install.ps1))) -Url ${ORIGIN} -Token ${TOKEN}`,
    );
    expect(command).not.toContain("| iex");
    expect(command).not.toContain("Invoke-Expression");
  });

  test("carries no sudo and no curl — neither exists on the host it is pasted into", () => {
    expect(command).not.toContain("sudo");
    expect(command).not.toContain("curl");
  });

  test("names switches install.ps1's own param() block declares", async () => {
    const script = await Bun.file(installerPath("install.ps1")).text();
    const paramBlock = script.slice(script.indexOf("param("), script.indexOf("$ErrorActionPreference"));
    for (const switchName of ["-Url", "-Token"]) {
      expect(command).toContain(`${switchName} `);
      // `[string] $Url,` — the declaration the emitted switch binds to.
      expect(paramBlock).toContain(`$${switchName.slice(1)}`);
    }
  });
});

describe("agentInstallCommand — the token and origin are never placeholders", () => {
  test.each([...AGENT_PLATFORMS])("%s carries both verbatim", (platform) => {
    const command = agentInstallCommand(platform, ORIGIN, TOKEN);
    expect(command).toContain(TOKEN);
    expect(command).toContain(ORIGIN);
    expect(command).not.toContain("<token>");
    expect(command).not.toContain("your-instance");
  });
});

describe("agentManualInstallCommands — Linux", () => {
  const steps = agentManualInstallCommands("linux", ORIGIN, TOKEN);

  test("is the four-step by-hand reproduction of install.sh", () => {
    expect(steps).toEqual([
      `curl -fsSL -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/api/agent/download?arch=x64" -o lazyit-agent`,
      "chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/",
      `sudo install -d -m 700 /etc/lazyit-agent && printf 'LAZYIT_URL=%s\\nLAZYIT_TOKEN=%s\\n' "${ORIGIN}" "${TOKEN}" | sudo tee /etc/lazyit-agent/config >/dev/null && sudo chmod 600 /etc/lazyit-agent/config`,
      "sudo lazyit-agent report --once --force",
    ]);
  });
});

describe("agentManualInstallCommands — Windows", () => {
  const steps = agentManualInstallCommands("windows", ORIGIN, TOKEN);

  test("is download-then-run: fetch the installer, read it, run it", () => {
    expect(steps).toEqual([
      `irm ${ORIGIN}/install.ps1 -OutFile .\\install.ps1`,
      `& ([scriptblock]::Create((Get-Content -Raw .\\install.ps1))) -Url ${ORIGIN} -Token ${TOKEN}`,
    ]);
  });

  test("runs the downloaded file through the SAME script-block form, not `.\\install.ps1`", () => {
    // A downloaded `.ps1` invoked as a file is subject to the host's execution policy, which is
    // `Restricted` by default on Windows client editions. The script block is built in memory from
    // the file's text, so it runs whatever that policy is — and it is not a second spelling of the
    // command: it is the form install.ps1's own header prescribes, sourced from disk instead of the
    // network. (What it does NOT do is reproduce install.ps1 by hand the way the Linux path does:
    // the ACL on the config file and the SYSTEM scheduled task are not four copy-pasteable lines.)
    expect(steps[1]).toContain("[scriptblock]::Create");
    expect(steps[1]).not.toMatch(/(^|\s)\.\\install\.ps1\s/);
  });

  test("keeps its backslashes — a JS string escape would silently eat them", () => {
    // `".\install.ps1"` in TypeScript is `.install.ps1`: `\i` is not an escape, so the backslash is
    // dropped without a warning. Every Windows path in this module is written `\\` for that reason.
    expect(steps[0]).toContain(".\\install.ps1");
    expect(steps[1]).toContain(".\\install.ps1");
  });

  test("names switches install.ps1's own param() block declares", async () => {
    const script = await Bun.file(installerPath("install.ps1")).text();
    expect(script).toContain("$Url");
    expect(script).toContain("$Token");
    expect(steps[1]).toContain("-Url ");
    expect(steps[1]).toContain("-Token ");
  });
});

describe("agentDiagnosticsCommand", () => {
  test("Linux runs the bare name — /usr/local/bin is on PATH", async () => {
    const command = agentDiagnosticsCommand("linux");
    expect(command).toBe("sudo lazyit-agent test");
    const script = await Bun.file(installerPath("install.sh")).text();
    expect(script).toContain("/usr/local/bin");
  });

  test("Windows runs the ABSOLUTE path, because the install dir is not on PATH (#1167)", async () => {
    const command = agentDiagnosticsCommand("windows");
    expect(command).toBe(
      '& "$env:ProgramFiles\\lazyit-agent\\lazyit-agent.exe" test',
    );
    // The spelling is the installer's own: `Join-Path $env:ProgramFiles 'lazyit-agent'`, not a
    // hard-coded `C:\Program Files`, so it survives a redirected or relocated ProgramFiles.
    const script = await Bun.file(installerPath("install.ps1")).text();
    expect(script).toContain("Join-Path $env:ProgramFiles 'lazyit-agent'");
    expect(script).toContain("'lazyit-agent.exe'");
    // #1167 is open: nothing in install.ps1 puts that directory on PATH, so the bare name would
    // raise CommandNotFoundException. This assertion is the tripwire — when #1167 lands and adds a
    // PATH write, it fails and this line gets re-read on purpose. The absolute form stays correct
    // either way, so the command above needs no change; only this guard does.
    expect(script).not.toMatch(/setx|SetEnvironmentVariable/i);
  });

  test("neither form carries the other platform's privilege verb", () => {
    expect(agentDiagnosticsCommand("windows")).not.toContain("sudo");
    expect(agentDiagnosticsCommand("linux")).not.toContain("ProgramFiles");
  });
});
