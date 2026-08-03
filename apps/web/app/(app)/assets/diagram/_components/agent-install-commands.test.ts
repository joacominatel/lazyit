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
  agentManualInstallSteps,
} from "./agent-install-commands";

const ORIGIN = "https://lazyit.example.com";
const TOKEN = "lzit_sa_xxx";

/** `apps/web/public/<name>` — the installers this instance actually serves. */
function installerPath(name: string): string {
  return path.join(import.meta.dir, "..", "..", "..", "..", "..", "public", name);
}

/** The slice of `infra.wizard` these tests hold both locales to. */
type WizardMessages = {
  requirements: Record<string, string>;
  diagnostics: Record<string, string>;
  manual: Record<string, Record<string, string>>;
};

/** `infra.wizard` out of `apps/web/messages/<locale>/infra.json` — the copy the wizard renders. */
async function wizardMessages(locale: string): Promise<WizardMessages> {
  const file = path.join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "..",
    "messages",
    locale,
    "infra.json",
  );
  const catalog = (await Bun.file(file).json()) as { wizard: WizardMessages };
  return catalog.wizard;
}

/** Both shipped locales, so a claim can never be asserted in English alone. */
const LOCALES = ["en", "es"] as const;

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

describe("agentManualInstallSteps — label and command travel together", () => {
  // The invariant this file exists to hold. The labels live in the message catalogs and the
  // commands live here; while they were two positionally-indexed arrays, an edit could add a step
  // to one and not the other and every test still passed. One structure plus this test is what
  // makes that impossible: each step names its own catalog key, and the key set has to be exactly
  // the `stepN` keys the catalogs ship, in order, in BOTH locales.
  test.each([...AGENT_PLATFORMS])(
    "%s: every step's labelKey is a real key in en and es, and no catalog step is orphaned",
    async (platform) => {
      const steps = agentManualInstallSteps(platform, ORIGIN, TOKEN);
      expect(steps.length).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        const wizard = await wizardMessages(locale);
        const catalogSteps = Object.keys(wizard.manual[platform] ?? {})
          .filter((key) => /^step\d+$/.test(key))
          .sort();
        expect(steps.map((step) => step.labelKey as string)).toEqual(
          catalogSteps.map((key) => `manual.${platform}.${key}`),
        );
        for (const step of steps) {
          const leaf = step.labelKey.split(".").at(-1) as string;
          expect(wizard.manual[platform]?.[leaf]).toBeTruthy();
        }
      }
    },
  );
});

describe("agentManualInstallSteps — Linux", () => {
  const steps = agentManualInstallSteps("linux", ORIGIN, TOKEN);

  test("is the four-step by-hand reproduction of install.sh", () => {
    expect(steps.map((step) => step.command)).toEqual([
      `curl -fsSL -H "Authorization: Bearer ${TOKEN}" "${ORIGIN}/api/agent/download?arch=x64" -o lazyit-agent`,
      "chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/",
      `sudo install -d -m 700 /etc/lazyit-agent && printf 'LAZYIT_URL=%s\\nLAZYIT_TOKEN=%s\\n' "${ORIGIN}" "${TOKEN}" | sudo tee /etc/lazyit-agent/config >/dev/null && sudo chmod 600 /etc/lazyit-agent/config`,
      "sudo lazyit-agent report --once --force",
    ]);
  });
});

describe("agentManualInstallSteps — Windows", () => {
  const steps = agentManualInstallSteps("windows", ORIGIN, TOKEN);

  test("is download-then-run: fetch the installer, read it, run it", () => {
    expect(steps.map((step) => step.command)).toEqual([
      `irm ${ORIGIN}/install.ps1 -OutFile "$env:TEMP\\lazyit-install.ps1"`,
      `& ([scriptblock]::Create((Get-Content -Raw "$env:TEMP\\lazyit-install.ps1"))) -Url ${ORIGIN} -Token ${TOKEN}`,
    ]);
  });

  test("saves the installer somewhere sane, NOT into the working directory", () => {
    // An elevated PowerShell — the one the wizard just told the operator to open — starts in
    // C:\Windows\System32, so a bare `-OutFile .\install.ps1` writes a downloaded script into the
    // system directory. Both steps name the same explicit destination under %TEMP% instead.
    expect(steps[0]?.command).toContain('-OutFile "$env:TEMP\\lazyit-install.ps1"');
    expect(steps[1]?.command).toContain('"$env:TEMP\\lazyit-install.ps1"');
    for (const step of steps) {
      expect(step.command).not.toContain(".\\install.ps1");
    }
  });

  test("runs the downloaded file through the SAME script-block form, not as a `.ps1` file", () => {
    // A downloaded `.ps1` invoked as a file is subject to the host's execution policy, which is
    // `Restricted` by default on Windows client editions. The script block is built in memory from
    // the file's text, so it runs whatever that policy is — and it is not a second spelling of the
    // command: it is the form install.ps1's own header prescribes, sourced from disk instead of the
    // network. (What it does NOT do is reproduce install.ps1 by hand the way the Linux path does:
    // the ACL on the config file and the SYSTEM scheduled task are not four copy-pasteable lines.)
    expect(steps[1]?.command).toContain("[scriptblock]::Create");
    expect(steps[1]?.command).not.toMatch(/(^|\s)"?[.$][^\s]*\.ps1"?\s+-Url/);
  });

  test("keeps its backslashes — a JS string escape would silently eat them", () => {
    // `"$env:TEMP\lazyit-install.ps1"` in TypeScript is `$env:TEMPlazyit-install.ps1`: `\l` is not
    // an escape, so the backslash is dropped without a warning. Every Windows path in this module
    // is written `\\` for that reason.
    for (const step of steps) {
      expect(step.command).toContain("TEMP\\lazyit-install.ps1");
    }
  });

  test("names switches install.ps1's own param() block declares", async () => {
    const script = await Bun.file(installerPath("install.ps1")).text();
    expect(script).toContain("$Url");
    expect(script).toContain("$Token");
    expect(steps[1]?.command).toContain("-Url ");
    expect(steps[1]?.command).toContain("-Token ");
  });
});

describe("agentDiagnosticsCommand", () => {
  test("Linux runs the bare name — /usr/local/bin is on PATH", async () => {
    const command = agentDiagnosticsCommand("linux");
    expect(command).toBe("sudo lazyit-agent test");
    const script = await Bun.file(installerPath("install.sh")).text();
    expect(script).toContain("/usr/local/bin");
  });

  test("Windows runs the ABSOLUTE path — the one form the pasting console can always run", async () => {
    const command = agentDiagnosticsCommand("windows");
    expect(command).toBe(
      '& "$env:ProgramFiles\\lazyit-agent\\lazyit-agent.exe" test',
    );
    // The spelling is the installer's own: `Join-Path $env:ProgramFiles 'lazyit-agent'`, not a
    // hard-coded `C:\Program Files`, so it survives a redirected or relocated ProgramFiles.
    const script = await Bun.file(installerPath("install.ps1")).text();
    expect(script).toContain("Join-Path $env:ProgramFiles 'lazyit-agent'");
    expect(script).toContain("'lazyit-agent.exe'");
    // This assertion used to be the INVERSE — a tripwire asserting nothing in install.ps1 wrote PATH
    // — from when #1167 was open and the bare name raised CommandNotFoundException. #1167 has landed
    // and the installer now edits the machine PATH through the registry, so the tripwire has fired
    // and is replaced by what it was watching for. The absolute form above did not need revising,
    // which was the reason it was chosen.
    //
    // It is asserted POSITIVELY now because the copy beside the command depends on it: `windowsNote`
    // tells the operator the full path is printed because their own console cannot see the new entry
    // — a sentence that becomes nonsense if the entry stops being written at all.
    expect(script).toContain(
      "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    );
  });

  test("neither form carries the other platform's privilege verb", () => {
    expect(agentDiagnosticsCommand("windows")).not.toContain("sudo");
    expect(agentDiagnosticsCommand("linux")).not.toContain("ProgramFiles");
  });
});

describe("the Windows copy states what the host must be, and what the shell must be", () => {
  // Two claims the commands themselves cannot carry, and both cost an operator the once-only token
  // if they are learned too late — the SA is minted in step 1, before any of this is read.
  test.each([...LOCALES])(
    "%s: requirements name x64 and rule out ARM64, the way install.ps1 does",
    async (locale) => {
      const script = await Bun.file(installerPath("install.ps1")).text();
      // The installer's own constraint: anything but AMD64 dies before a byte is downloaded.
      expect(script).toContain("$machine -ne 'AMD64'");
      const { requirements } = await wizardMessages(locale);
      expect(requirements.windows).toMatch(/x64/i);
      expect(requirements.windows).toMatch(/arm64/i);
      // Windows 10/11 or Server 2016+ — the floor the Manual states for the same host.
      expect(requirements.windows).toMatch(/10\/11/);
      expect(requirements.windows).toMatch(/2016/);
    },
  );

  test.each([...LOCALES])(
    "%s: the diagnostics note says the check needs an elevated PowerShell",
    async (locale) => {
      const script = await Bun.file(installerPath("install.ps1")).text();
      // WHY it needs one: the config file holding the URL and the token is ACL'd to SYSTEM and
      // Administrators only, so an unelevated `test` reads nothing and reports itself unconfigured
      // — an error that reads like a broken install.
      expect(script).toContain("'S-1-5-18', 'S-1-5-32-544'");
      const { diagnostics } = await wizardMessages(locale);
      expect(diagnostics.windowsNote).toMatch(locale === "es" ? /elevad/i : /elevated/i);
      expect(diagnostics.windowsNote).toMatch(/PowerShell/i);
    },
  );
});
