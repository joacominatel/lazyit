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

/**
 * THE SECOND DEFECT IN #1166. The operator on the first Windows host ran
 * `-Url http://192.168.100.75:8080/install.ps1` — the address of the SCRIPT, not the address of the
 * instance. Every request is built as `"$Url$Path"`, so that asks for
 * `http://192.168.100.75:8080/install.ps1/api/agent/download?...`, and the failure that surfaces is
 * a download error naming the token as a likely cause. The operator goes and rotates a credential
 * that was never wrong. This block pins the guard that names the real mistake instead.
 */
describe("-Url is the instance BASE URL, and a wrong one is named instead of blamed on the token (#1166)", () => {
  test("the address of this script is refused, and BEFORE anything is downloaded", () => {
    const guard = script.indexOf("not the address of this script");
    const download = script.indexOf("Invoke-LazyitDownload \"/api/agent/download");
    expect(guard).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(download);
  });

  test("an /api endpoint is refused too — the installer appends /api/agent/download itself", () => {
    expect(script).toContain("not an API endpoint");
  });

  test("a -Url with no scheme is refused by name, not left to fail inside Invoke-WebRequest", () => {
    expect(script).toContain("^https?://[^/]+");
    expect(script).toContain("starting with http:// or https://");
  });

  // Any OTHER path only warns. lazyit sets no Next.js basePath, so a path is almost always the
  // mistake above wearing a different shape — but a reverse proxy that strips a prefix really can
  // mount an instance under one, and an installer that refused it would break an upgrade path that
  // works today. The two Die branches above are the cases that can NEVER be a valid base URL.
  test("any other path WARNS and continues, so a prefix-stripping proxy still installs", () => {
    const warning = script.slice(script.indexOf("Write-Warning"), script.indexOf("[Net.ServicePointManager]"));
    expect(warning).toContain("carries a path");
    expect(script).not.toContain("Die \"-Url must not contain a path");
  });

  test("the parameter help shows the base-URL form and names the mistake", () => {
    expect(script).toContain("Your lazyit instance BASE URL");
    expect(script).toContain("NOT the address of this script");
  });
});

/**
 * WHICH BRANCH THE GUARD TAKES, decided by the shipped patterns rather than by a string match over
 * them (#1171 review).
 *
 * The header above explains why this file does not execute PowerShell, and that has not changed.
 * What changed is that asserting `toContain("^/install\\.(ps1|sh)")` was how a defect shipped: the
 * string is present and correct-looking, and the `^` means the fatal branch only fires when the
 * script is the FIRST path segment — so an instance mounted at https://it.example.com/lazyit, the
 * one deployment shape the warning branch exists to protect, warned and then failed the #1166 way.
 *
 * So the two branch patterns are READ OUT OF the script and evaluated over a table of paths. The
 * one thing this assumes is that these two particular patterns — `^(.*?)/install\.(ps1|sh)/` and
 * `^/api(/|$)` — mean the same thing to JavaScript's engine as to .NET's. Neither uses a construct
 * where the two differ (no balancing groups, no possessive quantifiers, no character-class
 * subtraction, no named group syntax), and the corpus below was additionally run through real
 * `pwsh` by hand. It is a check on the LOGIC, not a substitute for a Windows host.
 */
describe("the -Url guard's branch patterns, evaluated over the paths operators actually pass", () => {
  const GUARD = script.slice(
    script.indexOf("# --- -Url IS THE INSTANCE BASE URL"),
    script.indexOf("# TLS 1.2 explicitly."),
  );

  /**
   * The guard's `-match` patterns, read out of the block above. `-notmatch` (the scheme check) has
   * no `-match` substring, so it is excluded for free. Extraction happens INSIDE each test on
   * purpose: doing it in the describe body would make a failed extraction abort registration, and
   * the block would report zero tests instead of a failure — the exact "reads like coverage" trap
   * the header of this file argues against.
   */
  function pattern(kind: "install" | "api"): RegExp {
    const literals = [...GUARD.matchAll(/-match '([^']+)'/g)].map((m) => m[1] ?? "");
    const found = literals.find((l) => l.includes(kind));
    expect(found, `no -match literal mentioning ${kind} in the guard block; found ${JSON.stringify(literals)}`).toBeDefined();
    return new RegExp(found ?? "");
  }

  test("the script is refused wherever it sits in the path, not only as the first segment", () => {
    const scriptInPath = pattern("install");
    // The guard appends a '/' before matching, so the filename has to be a COMPLETE path segment.
    for (const path of ["/install.ps1", "/lazyit/install.ps1", "/lazyit/install.sh", "/a/b/install.ps1"]) {
      expect(scriptInPath.test(`${path}/`), path).toBe(true);
    }
  });

  test("the prefix it suggests keeping is everything before this script's own segment", () => {
    const scriptInPath = pattern("install");
    expect("/lazyit/install.ps1/".match(scriptInPath)?.[1]).toBe("/lazyit");
    expect("/install.ps1/".match(scriptInPath)?.[1]).toBe("");
  });

  test("a path that merely starts like this script is not mistaken for it", () => {
    const scriptInPath = pattern("install");
    for (const path of ["/install.ps1x", "/install.shed", "/installer", "/lazyit"]) {
      expect(scriptInPath.test(`${path}/`), path).toBe(false);
    }
  });

  test("/api is fatal at the start of the path and falls through to the warning under a prefix", () => {
    const apiInPath = pattern("api");
    expect(apiInPath.test("/api")).toBe(true);
    expect(apiInPath.test("/api/agent/download")).toBe(true);
    expect(apiInPath.test("/apidocs")).toBe(false);
    // Under a prefix mount /lazyit/api warns rather than dying — same as install.sh.
    expect(apiInPath.test("/lazyit/api")).toBe(false);
  });

  // FINDING 3. Both suggestions used to be built by pattern-stripping the WHOLE URL string, which
  // matched inside the host: `$Url -replace '/api.*$', ''` on https://api.example.com/api answers
  // `https:/`. They are built from the origin + the path prefix now, and a suggestion is pasted, so
  // a regression here hands the operator a URL that cannot work.
  test("the suggested replacements are assembled from the origin, not stripped off the whole URL", () => {
    expect(GUARD).toContain("$UrlOrigin");
    expect(GUARD).not.toMatch(/\$Url -replace '\/(install|api)/);
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

  // THE BUG THIS PINS. A repetition is a property OF a trigger: Microsoft defines the repetition
  // pattern as "how long the repetition pattern is repeated AFTER THE TASK IS STARTED", and Task
  // Scheduler "can run a task any number of times after a trigger is fired". So a repetition hung on
  // the -AtStartup trigger ALONE does not begin until the machine next BOOTS — and -AtStartup does
  // not fire for a boot that already happened. On a running host that installer produced an agent
  // that reported once and then went silent until somebody rebooted it. `-StartWhenAvailable` does
  // not rescue it either: it "applies only to time-based tasks", which a boot trigger is not.
  //
  // The systemd unit this was translated from has TWO independent activations (OnBootSec= and
  // OnUnitActiveSec=); the translation had collapsed them into one. Both must be registered.
  test("TWO independent triggers are registered — the tick does not wait for a reboot", () => {
    // The tick rides its own TIME-BASED trigger starting NOW, which is what makes the repetition
    // begin at install time on a machine that is already running.
    expect(script).toContain("New-ScheduledTaskTrigger -Once -At (Get-Date)");
    expect(script).toContain("-RepetitionInterval (New-TimeSpan -Minutes $TickMinutes)");
    // …and BOTH go to Register-ScheduledTask, which takes "an array of one or more trigger objects"
    // and starts the task "when ANY of the triggers occur".
    expect(script).toContain("-Trigger @($bootTrigger, $tickTrigger)");
  });

  test("the repetition is NOT grafted onto the startup trigger — that is the defect", () => {
    // The old shape was `$trigger.Repetition = (New-ScheduledTaskTrigger -Once …).Repetition`, which
    // is a single boot-gated trigger wearing a repetition it can never start.
    expect(script).not.toContain(".Repetition =");
  });

  test("the random delay rides the TIME trigger only — a boot trigger has nowhere to put it", () => {
    // `timeTriggerType` extends the trigger base type with exactly one element, `RandomDelay`;
    // `bootTriggerType` extends it with exactly one element, `Delay`. So a boot trigger has no schema
    // home for a random delay however willingly `New-ScheduledTaskTrigger` accepts the parameter —
    // and the estate's real de-phasing is the agent's own machine-id-keyed cadence jitter (#1140).
    expect(script).toContain("New-ScheduledTaskTrigger -AtStartup\n");
    expect(script).toContain("$bootTrigger.Delay = 'PT2M'");
    expect(script).toContain("-Once -At (Get-Date) -RandomDelay $RandomDelay");
  });

  test("the random delay rides the TRIGGERS — New-ScheduledTaskSettingsSet has no -RandomDelay", () => {
    // Documented on New-ScheduledTaskTrigger for every parameter set, and absent from
    // New-ScheduledTaskSettingsSet's syntax entirely. Passing it to the settings set throws
    // "A parameter cannot be found that matches parameter name 'RandomDelay'" — and with
    // $ErrorActionPreference='Stop' that aborts the install AFTER the binary and config are written.
    const settings = script.slice(
      script.indexOf("$settings = New-ScheduledTaskSettingsSet"),
      script.indexOf("$taskPrincipal ="),
    );
    expect(settings.length).toBeGreaterThan(0);
    expect(settings).not.toContain("-RandomDelay");
  });

  // THE SECOND HALF OF THE SAME DEFECT. A repetition can be rejected by TWO different calls, and the
  // two documented errors name two different cmdlets:
  //
  //   * `New-ScheduledTaskTrigger : The RepetitionInterval and RepetitionDuration Job trigger
  //     parameters must be specified together.` — the older cmdlet (Server 2012), refusing an
  //     interval with no duration while the trigger OBJECT is being built.
  //   * `Set-ScheduledTask : The task XML contains a value which is incorrectly formatted or out of
  //     range. (12,42):Duration:P99999999DT23H59M59S` — the `[TimeSpan]::MaxValue` idiom, rejected by
  //     the REGISTERING cmdlet, because the task XML is validated there and not at construction.
  //
  // A fallback that wraps only construction therefore does not cover the call the duration is
  // actually validated by — and registration is what runs AFTER the binary and the token file are
  // already on disk. A fallback that misses its own case is worse than none: it reads as handled.
  test("the repetition fallback covers REGISTRATION too, not only trigger construction", () => {
    const registration = script.slice(script.indexOf("$taskPrincipal ="));
    expect(registration.length).toBeGreaterThan(0);
    // The register call is attempted inside a try, and the catch rebuilds the trigger with a finite,
    // in-schema duration and registers again.
    expect(registration).toContain("try { Register-AgentTask }");
    expect(registration).toContain("$tickTrigger = New-TickTrigger $FallbackDuration");
  });

  test("the fallback fires ONCE — a second failure rethrows instead of burying the real error", () => {
    // If the first attempt already carried a finite duration, the repetition is not what this host
    // objects to, and retrying an identical registration would swallow whatever the real fault was.
    expect(script).toContain("if ($usedFallbackDuration) { throw }");
  });

  test("the first attempt omits the duration, and MaxValue never comes back", () => {
    // "If no value is specified for the duration, then the pattern is repeated indefinitely" — the
    // finite duration is the COMPATIBILITY branch, never the default.
    expect(script).toContain("New-TickTrigger ([TimeSpan]::Zero)");
    expect(script).toContain("$FallbackDuration = New-TimeSpan -Days 3650");
    // The idiom itself is still NAMED in the comment that explains why it is gone — what must never
    // come back is PASSING it, so the assertion is on the argument and not on the word.
    expect(script).not.toContain("-RepetitionDuration ([TimeSpan]::MaxValue)");
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
