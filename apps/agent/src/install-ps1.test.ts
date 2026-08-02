import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AGENT_POLICY_TICK_SECONDS } from "@lazyit/shared";
import { defaultConfigFile, defaultStateDir } from "./paths";

/**
 * A contract test over `apps/web/public/install.ps1` (#1144), mirroring `install-sh.test.ts`.
 *
 * It lives in `apps/agent` for the same reason its Linux sibling does: this is the only workspace
 * with a test runner that will look at it, and the installer is the agent's other half — it
 * registers the task the agent runs under and picks the artifact the agent is.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. It asserts the SHAPE of the installer: the checks it makes
 * before it writes anything, the task settings a reviewer greps for, the ACL that replaces
 * `chmod 600`, and that uninstall destroys the token. It does NOT parse or execute PowerShell — this
 * repo's CI is Linux and its developers are on macOS, so there is no interpreter to ask. Installing
 * on a real Windows host remains the only proof that the script RUNS, and the Manual says so.
 *
 * `pwsh -NoProfile -Command "..."` on a machine that happens to have PowerShell installed would be a
 * strictly better test. It is deliberately not attempted conditionally: a check that silently does
 * nothing on every machine that runs it is worse than an honest absence, because it reads like
 * coverage.
 */
const INSTALL_PS1 = join(import.meta.dir, "..", "..", "web", "public", "install.ps1");
const script = await Bun.file(INSTALL_PS1).text();

describe("nothing is installed until the host has been checked", () => {
  test("elevation is required, and checked before any write", () => {
    const elevation = script.indexOf("WindowsBuiltInRole]::Administrator");
    const firstWrite = script.indexOf("New-Item -ItemType Directory");
    expect(elevation).toBeGreaterThan(-1);
    expect(elevation).toBeLessThan(firstWrite);
  });

  test("the download is rejected unless it is a PE executable (the ELF-magic check, one platform over)", () => {
    // 0x4D 0x5A = 'MZ'. Catches an HTML or JSON error page that arrived as a 200 — the failure mode
    // that would otherwise register a scheduled task pointing at a login page.
    expect(script).toContain("0x4D");
    expect(script).toContain("0x5A");
  });

  test("the published sha256 is compared, and -RequireChecksum makes its absence fatal", () => {
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("^[0-9a-f]{64}$");
    expect(script).toContain("checksum mismatch");
    expect(script).toContain("-RequireChecksum was passed but this instance published no sha256");
  });

  test("a redirect is a hard failure, not a followed hop (#980)", () => {
    // -Url pointed at the raw web port 302s to /login; saving that as an executable is the bug.
    expect(script).toContain("MaximumRedirection = 0");
  });

  test("the executable is RUN once before any task is registered, and removed again if it fails", () => {
    const runCheck = script.indexOf("& $BinPath --help");
    const register = script.indexOf("Register-ScheduledTask -TaskName");
    expect(runCheck).toBeGreaterThan(-1);
    expect(runCheck).toBeLessThan(register);
    expect(script).toContain("no task was registered");
  });

  test("the download asks for the os explicitly — the arch alone is not a filename any more", () => {
    expect(script).toContain("/api/agent/download?os=windows&arch=$arch");
    expect(script).toContain("/api/agent/checksum?os=windows&arch=$arch");
  });
});

describe("the scheduled task is the systemd timer, one platform over", () => {
  test("it runs as SYSTEM at the highest run level — never a domain service account", () => {
    // SYSTEM has local WMI/CIM rights with NO credential stored on the host. A domain account would
    // put a password in a file on every machine in the estate.
    expect(script).toContain("-UserId 'SYSTEM'");
    expect(script).toContain("-RunLevel Highest");
    expect(script).not.toContain("-Password");
  });

  test("the tick matches AGENT_POLICY_TICK_SECONDS and is not the reporting cadence", () => {
    expect(AGENT_POLICY_TICK_SECONDS).toBe(300);
    expect(script).toContain("$TickMinutes = 5");
    expect(script).toContain("New-TimeSpan -Minutes $TickMinutes");
  });

  test("it has an at-startup trigger, catches up a missed tick, and de-phases the estate", () => {
    expect(script).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(script).toContain("-StartWhenAvailable");
    expect(script).toContain("-RandomDelay $RandomDelay");
  });

  test("one run is bounded — the RuntimeMaxSec analogue", () => {
    expect(script).toContain("-ExecutionTimeLimit $ExecutionTimeLimit");
    expect(script).toContain("$ExecutionTimeLimit = New-TimeSpan -Minutes 5");
  });

  test("a laptop on battery still reports — most of this estate is laptops", () => {
    expect(script).toContain("-AllowStartIfOnBatteries");
    expect(script).toContain("-DontStopIfGoingOnBatteries");
  });

  test("it runs the same one-shot command the systemd unit does", () => {
    expect(script).toContain("-Argument 'report --once'");
  });
});

describe("the config file holds a live credential and is protected like one", () => {
  test("it is written where the BINARY looks for it", () => {
    // The two halves of this pair are the whole point: an installer writing a file the agent does not
    // read produces a host that looks configured and reports "missing URL and/or token".
    expect(script).toContain("Join-Path $env:ProgramData 'lazyit-agent'");
    expect(script).toContain("Join-Path $ConfigDir 'config'");
    // The Linux CI runner cannot ask `paths.ts` for the Windows answer, so the literals are pinned on
    // both sides instead — asserting the agent's own default against the same spelling.
    expect(defaultConfigFile({ ProgramData: "C:\\ProgramData" } as never)).toBe(
      process.platform === "win32" ? "C:\\ProgramData\\lazyit-agent\\config" : "/etc/lazyit-agent/config",
    );
    expect(script).toContain("Join-Path $ConfigDir 'state'");
    expect(defaultStateDir({ ProgramData: "C:\\ProgramData" } as never)).toBe(
      process.platform === "win32" ? "C:\\ProgramData\\lazyit-agent\\state" : "/var/lib/lazyit-agent",
    );
  });

  test("inheritance is DISABLED and the ACL is rebuilt for SYSTEM + Administrators only", () => {
    // The `chmod 600` analogue. A fresh %ProgramData% directory inherits an ACE granting Users read
    // access, and an inherited ACE cannot be removed while inheritance is on — so protection has to
    // come first, and it has to discard rather than copy what was inherited.
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
    expect(script).toContain("'S-1-5-18', 'S-1-5-32-544'");
  });

  test("it is written as UTF-8 with NO byte-order mark — the agent parses it as UTF-8 text", () => {
    // `-Encoding UTF8` on Windows PowerShell 5.1 writes a BOM, which lands in front of the first key
    // and makes it unparseable; `-Encoding ASCII` would mangle a non-ASCII proxy host or CA path.
    expect(script).toContain(
      "[IO.File]::WriteAllLines($ConfigFile, $lines, (New-Object Text.UTF8Encoding($false)))",
    );
    // …and no `Set-Content -Encoding` anywhere near it. Asserted as the CALL rather than the flag,
    // because the two rejected encodings are named in the comment above that line and a bare
    // substring match would fail on the explanation instead of on a real regression.
    expect(script).not.toContain("Set-Content -LiteralPath $ConfigFile");
  });

  test("a re-install PRESERVES this host's own limits, its proxy and its CA (#1140/#1137)", () => {
    // Truncating this file on the upgrade path would silently re-enable collection the host's owner
    // turned off, or cut a proxied host off the network, with nothing on screen to say so.
    expect(script).toContain("LAZYIT_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|lazyit_ca_file");
    // …except the three keys the installer owns, which the parameters supply fresh.
    expect(script).toContain("^\\s*LAZYIT_(URL|TOKEN|INTERVAL)=");
  });

  test("-Interval is accepted and ignored — cadence is a server-side setting since #1140", () => {
    expect(script).toContain("was passed and IGNORED");
  });
});

describe("uninstall", () => {
  test("disarms the task BEFORE removing the executable", () => {
    const unregister = script.indexOf("Unregister-ScheduledTask");
    const removeBin = script.indexOf("Remove-Item -LiteralPath $BinPath");
    expect(unregister).toBeGreaterThan(-1);
    expect(unregister).toBeLessThan(removeBin);
  });

  test("the token never survives it, even with -KeepConfig", () => {
    // -KeepConfig is for re-imaging a host that will get the agent back: it keeps the LOCAL VETO,
    // which is the host owner's setting, while still stripping the token and the URL.
    expect(script).toContain("^\\s*LAZYIT_(TOKEN|URL)=");
    expect(script).toContain("Remove-Item -LiteralPath $StateDir");
  });
});

describe("the unsigned-binary state is stated, not hidden", () => {
  test("the script says so where an operator will read it", () => {
    // An OV/EV code-signing certificate is an explicit GATE before any third party installs this.
    // Saying it in the installer is what keeps it from shipping externally by accident.
    expect(script).toContain("UNSIGNED, ON PURPOSE, FOR NOW");
    expect(script).toContain("code-signing certificate is an explicit GATE");
  });

  test("the run-check failure names antivirus first — it is the likely cause on Windows", () => {
    expect(script).toContain("antivirus or SmartScreen quarantining it");
  });
});

describe("there is no windows/arm64 build, and the installer says so rather than guessing", () => {
  test("a non-AMD64 host is refused by name", () => {
    expect(script).toContain("PROCESSOR_ARCHITECTURE");
    expect(script).toContain("there is no ARM64 target");
  });

  test("-Baseline is explicit because Windows has no /proc/cpuinfo to auto-detect from", () => {
    expect(script).toContain("$arch = if ($Baseline) { 'x64-baseline' } else { 'x64' }");
    // And it never silently substitutes the AVX2 build for the baseline one, which would trade a
    // clear install error for an illegal-instruction crash weeks later.
    expect(script).toContain("will not substitute the ordinary x64 build");
  });
});
