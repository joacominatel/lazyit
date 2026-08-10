import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("the published sha256 is compared, and the check is REQUIRED — it cannot fail open (#1190)", () => {
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("^[0-9a-f]{64}$");
    expect(script).toContain("checksum mismatch");
    // THE FAIL-OPEN SHAPE THIS REPLACES. Any error fetching the digest silently degraded the check
    // to a warning unless -RequireChecksum was passed — so an attacker who could 404 one route
    // stripped the verification entirely. A check the party being checked can strip is not a check.
    expect(script).not.toContain("catch { $expected = '' }");
    expect(script).not.toContain("Pass -RequireChecksum to make this fatal");
    expect(script).toContain("checksum verification is REQUIRED");
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
 * `^/api(/|$)` — mean the same thing to JavaScript's engine as to .NET's over the inputs below.
 * Neither uses a construct where the two engines differ (no balancing groups, no possessive
 * quantifiers, no character-class subtraction, no named groups); the one difference that could
 * matter, .NET's `$` also matching before a trailing newline, cannot bite on a URL path. The corpus
 * below was additionally run through real `pwsh` by hand. It is a check on the LOGIC of the guard,
 * not a substitute for a Windows host.
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
    // Comment lines are dropped first: the guard's own prose QUOTES the broken form it replaced,
    // which is worth keeping and is not code.
    const code = GUARD.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).toContain("$UrlOrigin");
    expect(code).not.toMatch(/\$Url -replace '\/(install|api)/);
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
    expect(script).toContain("^\\s*LAZYIT_(URL|TOKEN|INTERVAL)\\s*=");
  });

  // A KEY WITH SPACE AROUND IT IS STILL THAT KEY, because `readConfigFile` in the agent trims the
  // key before it compares. Both halves have to widen together: a padded `LAZYIT_COLLECT_*=false`
  // that the keep-pattern misses is a host owner's veto DELETED on the upgrade path, and a padded
  // `LAZYIT_TOKEN =` that the owned pattern misses survives into the kept block BELOW the fresh
  // one — where the agent's last-assignment-wins parser would pick the stale credential.
  test("padded keys are recognised on both sides of the merge, or neither is safe", () => {
    const keep = script.match(/Where-Object \{ \$_ -match '([^']+)' \}/)?.[1];
    const owned = [...script.matchAll(/'(\^\\s\*\(?LAZYIT_[^']+)'/g)].map((one) => one[1] as string);
    expect(keep, "install.ps1 no longer filters the previous config this way").toBeTruthy();
    expect(keep).toContain("\\s*=");
    expect(owned.length).toBeGreaterThan(0);
    for (const pattern of owned) expect(pattern, pattern).toContain("\\s*=");
  });

  // The one promise this installer cannot bend: the token NEVER survives an uninstall. A padded
  // `LAZYIT_TOKEN =` the strip-pattern did not recognise would be left on a decommissioned host, as
  // a working credential, in a file the operator was told keeps only their own limits.
  test("-KeepConfig strips a padded token line too", () => {
    expect(script).toContain("-notmatch '^\\s*LAZYIT_(TOKEN|URL)\\s*='");
  });

  test("-Interval is accepted and ignored — cadence is a server-side setting since #1140", () => {
    expect(script).toContain("was passed and IGNORED");
  });
});

/**
 * THE INSTALL DIRECTORY ON THE MACHINE PATH (#1167).
 *
 * `install.sh` drops the agent in `/usr/local/bin`, which is on PATH on every distribution this
 * supports, so `sudo lazyit-agent test` — the command the Manual documents — just works. This
 * installer drops it in `%ProgramFiles%\lazyit-agent`, which is on nobody's PATH, and never wrote
 * one. The first real Windows host answered the documented command with
 * `The term 'lazyit-agent' is not recognized`, at exactly the moment an operator reaches for it:
 * when something is already wrong.
 *
 * HOW THIS IS TESTED. The two functions that decide the edit are PURE — they take the raw PATH
 * string and a directory and answer a string, with no registry and no environment of their own. That
 * is what makes them runnable off Windows: the corpus below is executed by real PowerShell
 * (`pwsh`, which the ubuntu-latest CI image ships and `brew install powershell` provides), against
 * the functions read OUT OF the shipped `install.ps1` rather than a copy pasted in here.
 *
 * On a machine with no PowerShell at all the same corpus runs through a model of those two
 * functions, and the assertion message names which engine answered — a fallback that asserts the
 * same table is not the "silently does nothing" trap the header of this file argues against, but it
 * is weaker, so the text checks below pin the operations the model mirrors. CI runs the real one.
 */
const PATH_DIR = "C:\\Program Files\\lazyit-agent";

type PathCase = {
  /** What the machine PATH holds before the installer touches it (the RAW registry value). */
  raw: string;
  /** How many entries `Split-LazyitPath` recognises as the install directory. */
  dropped: number;
  /** What survives that split, joined back with ';' — the uninstall answer. */
  kept: string;
  /** What `Join-LazyitPath` answers: the new value, or null when it is already there. */
  joined: string | null;
};

const PATH_CASES: Record<string, PathCase> = {
  "a PATH without it gets it appended": {
    raw: "C:\\Windows\\system32;C:\\Windows",
    dropped: 0,
    kept: "C:\\Windows\\system32;C:\\Windows",
    joined: "C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\lazyit-agent",
  },
  // THE IDEMPOTENCE THAT MATTERS. Re-running the installer is the documented upgrade path, so this
  // case runs on every host in the estate that is ever upgraded, not on an exotic one.
  "a re-install does not append it a second time": {
    raw: "C:\\Windows;C:\\Program Files\\lazyit-agent",
    dropped: 1,
    kept: "C:\\Windows",
    joined: null,
  },
  "a trailing backslash is the same directory": {
    raw: "C:\\Program Files\\lazyit-agent\\;C:\\Windows",
    dropped: 1,
    kept: "C:\\Windows",
    joined: null,
  },
  "case does not make it a different directory — Windows paths are not case-sensitive": {
    raw: "c:\\program files\\LAZYIT-AGENT;C:\\Windows",
    dropped: 1,
    kept: "C:\\Windows",
    joined: null,
  },
  // An entry somebody wrote by hand as a variable is still this directory. Expanding the entry
  // before comparing is what keeps the upgrade path from stacking a second copy beside it.
  "an entry written unexpanded is recognised as this directory": {
    raw: "%ProgramFiles%\\lazyit-agent;C:\\Windows",
    dropped: 1,
    kept: "C:\\Windows",
    joined: null,
  },
  "a directory that merely starts the same is left alone": {
    raw: "C:\\Program Files\\lazyit-agent-old;C:\\Program Files\\lazyit-agentx",
    dropped: 0,
    kept: "C:\\Program Files\\lazyit-agent-old;C:\\Program Files\\lazyit-agentx",
    joined: "C:\\Program Files\\lazyit-agent-old;C:\\Program Files\\lazyit-agentx;C:\\Program Files\\lazyit-agent",
  },
  // THE DESTRUCTIVE ONE. The machine PATH is a REG_EXPAND_SZ holding literal `%SystemRoot%`
  // entries. Anything that reads it expanded and writes the result back flattens those forever, on
  // every host that installs an inventory agent. Entries this script does not own come back byte
  // for byte, in both directions.
  "an unexpanded entry the installer does not own survives verbatim": {
    raw: "%SystemRoot%\\system32;C:\\Program Files\\lazyit-agent;C:\\tools",
    dropped: 1,
    kept: "%SystemRoot%\\system32;C:\\tools",
    joined: null,
  },
  "a value that already ends in a separator does not gain an empty entry": {
    raw: "C:\\Windows;",
    dropped: 0,
    kept: "C:\\Windows;",
    joined: "C:\\Windows;C:\\Program Files\\lazyit-agent",
  },
  "an empty PATH becomes just this directory": {
    raw: "",
    dropped: 0,
    kept: "",
    joined: "C:\\Program Files\\lazyit-agent",
  },
  "whitespace around an entry does not hide it": {
    raw: "C:\\Windows; C:\\Program Files\\lazyit-agent ",
    dropped: 1,
    kept: "C:\\Windows",
    joined: null,
  },
};

/** A complete `function <name>(...) { ... }` definition, read out of the shipped installer. */
function powershellFunction(name: string): string {
  const start = script.indexOf(`function ${name}(`);
  expect(start, `install.ps1 defines no function ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = script.indexOf("{", start); i < script.length; i += 1) {
    if (script[i] === "{") depth += 1;
    else if (script[i] === "}") {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

type PathAnswer = { dropped: number; kept: string; joined: string | null };

const POWERSHELL = Bun.which("pwsh") ?? Bun.which("powershell");

/** The shipped functions, run by real PowerShell over the corpus. */
function answersFromPowerShell(shell: string): Record<string, PathAnswer> {
  const dir = mkdtempSync(join(tmpdir(), "lazyit-install-ps1-"));
  const casesFile = join(dir, "cases.json");
  const driver = join(dir, "driver.ps1");
  writeFileSync(
    casesFile,
    JSON.stringify(
      Object.entries(PATH_CASES).map(([name, one]) => ({ name, raw: one.raw, dir: PATH_DIR })),
    ),
  );
  writeFileSync(
    driver,
    [
      // The same strictness the installer itself runs under, so a strict-mode fault in either
      // function surfaces here rather than on a Windows host.
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      // The corpus is a Windows PATH; give the process the one variable it expands.
      "$env:ProgramFiles = 'C:\\Program Files'",
      powershellFunction("Split-LazyitPath"),
      powershellFunction("Join-LazyitPath"),
      "foreach ($case in (Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json)) {",
      "  $split = Split-LazyitPath $case.raw $case.dir",
      "  [pscustomobject]@{",
      "    name = $case.name",
      "    dropped = $split.Dropped",
      "    kept = ($split.Entries -join ';')",
      "    joined = (Join-LazyitPath $case.raw $case.dir)",
      "  } | ConvertTo-Json -Compress",
      "}",
      "",
    ].join("\n"),
  );

  const run = Bun.spawnSync([shell, "-NoProfile", "-File", driver, casesFile]);
  const stdout = new TextDecoder().decode(run.stdout);
  expect(
    run.exitCode,
    `${shell} could not run the shipped PATH functions:\n${new TextDecoder().decode(run.stderr)}`,
  ).toBe(0);

  const answers: Record<string, PathAnswer> = {};
  for (const line of stdout.split("\n").filter((one) => one.trim() !== "")) {
    const parsed = JSON.parse(line) as { name: string; dropped: number; kept: string; joined: string | null };
    answers[parsed.name] = { dropped: parsed.dropped, kept: parsed.kept, joined: parsed.joined };
  }
  return answers;
}

/** The same two functions, modelled — used only where there is no PowerShell to ask. */
function answersFromModel(): Record<string, PathAnswer> {
  const environment: Record<string, string> = { programfiles: "C:\\Program Files" };
  const expand = (value: string) =>
    value.replace(/%([^%]+)%/g, (whole, name: string) => environment[name.toLowerCase()] ?? whole);
  const normalise = (value: string) => expand(value).trim().replace(/\\+$/, "");
  const target = normalise(PATH_DIR).toLowerCase();

  const answers: Record<string, PathAnswer> = {};
  for (const [name, one] of Object.entries(PATH_CASES)) {
    const kept: string[] = [];
    let dropped = 0;
    for (const entry of one.raw.split(";")) {
      const normal = normalise(entry);
      if (normal !== "" && normal.toLowerCase() === target) dropped += 1;
      else kept.push(entry);
    }
    let joined: string | null = null;
    if (dropped === 0) {
      if (one.raw.trim() === "") joined = PATH_DIR;
      else if (one.raw.endsWith(";")) joined = `${one.raw}${PATH_DIR}`;
      else joined = `${one.raw};${PATH_DIR}`;
    }
    answers[name] = { dropped, kept: kept.join(";"), joined };
  }
  return answers;
}

const ENGINE = POWERSHELL ? `real PowerShell (${POWERSHELL})` : "the model (no pwsh on this machine)";

/**
 * Memoised, and resolved INSIDE a test rather than in the describe body on purpose: an extraction
 * that throws while the block is being registered reports zero tests instead of a failure, which is
 * the "reads like coverage" trap this file's header argues against.
 *
 * WHO PAYS FOR THE RESOLUTION IS PART OF THE DESIGN (#1186). On a machine with PowerShell — which
 * includes every `ubuntu-latest` runner, where `pwsh` is preinstalled — the first caller pays a real
 * process spawn, and PowerShell Core's cold start on a loaded shared runner comfortably exceeds
 * Bun's default 5000 ms per-test budget. Charging that to whichever case test happened to run first
 * red-lit CI at random (run 30781764638: `a PATH without it gets it appended [5013.87ms]`, 312 pass /
 * 1 fail, green on a plain re-run). The lazy resolution stays — it is load-bearing — but the cost is
 * charged deliberately, to the warm-up test below, which carries a budget sized for a spawn. Every
 * case test then reads the memo in microseconds and keeps the default timeout, so a genuinely slow
 * assertion is still caught. Raising the GLOBAL timeout was rejected: it would hide exactly that.
 *
 * `chargedTo` records who paid, so the arrangement is asserted rather than assumed — a future edit
 * that reorders the block or drops the warm-up fails loudly here instead of going back to flaking on
 * CI once a fortnight.
 */
let memoised: Record<string, PathAnswer> | undefined;
let chargedTo: string | undefined;
const WARM_UP = "the corpus warm-up";
function answers(charge: string): Record<string, PathAnswer> {
  if (memoised === undefined) {
    chargedTo = charge;
    memoised = POWERSHELL ? answersFromPowerShell(POWERSHELL) : answersFromModel();
  }
  return memoised;
}

/**
 * A budget sized for what this actually does: start a PowerShell interpreter on a shared CI runner
 * that may be paging. It is generous on purpose — the point is not to bound the spawn, it is to stop
 * the spawn being billed to an assertion that should take microseconds.
 */
const WARM_UP_TIMEOUT_MS = 60_000;

describe("the install directory lands on the machine PATH, once (#1167)", () => {
  // FIRST in the block, so it is the caller that resolves the corpus. `bun test` runs the tests of a
  // describe in declaration order, which is what makes this deterministic rather than lucky.
  test(
    WARM_UP,
    () => {
      // Still a real assertion, not a bare warm-up: an engine that answers a partial table would
      // otherwise surface as N confusing per-case failures instead of one honest "the corpus is
      // incomplete".
      expect(Object.keys(answers(WARM_UP)).sort()).toEqual(Object.keys(PATH_CASES).sort());
    },
    WARM_UP_TIMEOUT_MS,
  );

  test("both halves of the edit are PURE functions, so they can be run off Windows", () => {
    // If either stops taking the raw value as a parameter, the corpus below stops testing the
    // shipped logic and starts testing whatever it closed over.
    expect(powershellFunction("Split-LazyitPath")).toContain("function Split-LazyitPath([string] $RawPath, [string] $Dir)");
    expect(powershellFunction("Join-LazyitPath")).toContain("function Join-LazyitPath([string] $RawPath, [string] $Dir)");
    // The operations the model mirrors, so the fallback engine is not asserting against a fantasy.
    const split = powershellFunction("Split-LazyitPath");
    expect(split).toContain("-split ';'");
    expect(split).toContain("[Environment]::ExpandEnvironmentVariables");
    expect(split).toContain("TrimEnd('\\')");
    expect(split).toContain("-ieq");
  });

  for (const [name, expected] of Object.entries(PATH_CASES)) {
    test(name, () => {
      const answer = answers(name)[name];
      expect(answer, `${name}: ${ENGINE} answered nothing`).toBeDefined();
      expect({ ...answer }, `${name}, answered by ${ENGINE}`).toEqual({
        dropped: expected.dropped,
        kept: expected.kept,
        joined: expected.joined,
      });
    });
  }

  // LAST, because it can only be true once at least one case test has run off the memo. Before
  // #1186 this named whichever case ran first, which is precisely the bug: a `pwsh` cold start was
  // being charged to a 5000 ms per-test budget that was never sized for a process spawn.
  test("no CASE test paid for the pwsh spawn — the corpus was warm before they ran (#1186)", () => {
    expect(chargedTo).toBe(WARM_UP);
  });
});

/**
 * The registry side of the same edit — which cannot be executed off Windows, so it is pinned by the
 * two idioms it must never come back to.
 */
describe("the PATH edit goes through the registry, and never abandons an install that fails it", () => {
  test("neither setx nor .NET's machine-target setter is used to write it", () => {
    // `setx` TRUNCATES what it writes at 1024 characters: a longer machine PATH comes back
    // permanently shortened on a host somebody just installed an inventory agent on.
    expect(script).not.toContain("setx ");
    // .NET expands a REG_EXPAND_SZ value on the way out and writes the result back as a plain
    // REG_SZ, which flattens every `%SystemRoot%` entry the value had. The words appear in the
    // comment that explains why they are gone, so the assertion is on the CALL.
    expect(script).not.toContain("[Environment]::SetEnvironmentVariable(");
    // On the CALL, and on BOTH of them. Asserted as a bare word this passes on the comment that
    // explains why the option is there, which is how a green test hides a value read expanded.
    const rawRead = "$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)";
    expect(script.split(rawRead).length - 1, "both the add and the remove path must read the RAW value").toBe(2);
    // And written back under the kind it already had, so a REG_EXPAND_SZ does not become a REG_SZ
    // whose %SystemRoot% entries stop expanding.
    expect(script.split("GetValueKind('Path')").length - 1).toBe(2);
  });

  test("a new console really does see it — the environment change is broadcast", () => {
    // Without WM_SETTINGCHANGE (0x1A) to HWND_BROADCAST (0xffff), a console opened from the Start
    // menu inherits the environment block explorer.exe cached when it started, and the closing
    // message below would be promising something false until the operator signed out.
    // The CALL, with its arguments: both the constant and the function name appear in the comment
    // above it and in the DllImport beside it, so a bare-word assertion stays green on a script that
    // declares the import and never invokes it.
    expect(script).toContain(
      "[Lazyit.Env]::SendMessageTimeout([IntPtr] 0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref] $answer)",
    );
    // …and both edits publish it. Removing the entry without telling the desktop leaves the bare
    // name resolving to a deleted executable in every console that had already picked it up.
    expect(script.split("  Publish-LazyitEnvironmentChange\n").length - 1).toBe(2);
  });

  test("failing to write it warns and continues — the agent does not need it", () => {
    // The task runs $BinPath by absolute path and every message this script prints does the same, so
    // a host with a locked-down registry ACL is a fully working agent missing a convenience. Aborting
    // there would throw away a completed install over one.
    const call = script.slice(script.indexOf("$onPath = $false"), script.indexOf("# --- config (ACL"));
    expect(call.length).toBeGreaterThan(0);
    expect(call).toContain("Add-InstallDirToPath");
    expect(call).toContain("Write-Warning");
    expect(call).not.toContain("Die ");
  });

  test("it happens only after the executable has been proven to start", () => {
    const runCheck = script.indexOf("& $BinPath --help");
    const pathEdit = script.indexOf("$onPath = $false");
    expect(pathEdit).toBeGreaterThan(runCheck);
  });

  test("the closing message keeps the absolute path and does not promise this console", () => {
    const closing = script.slice(script.indexOf("Say \"done."));
    expect(closing).toContain("'$BinPath test'");
    expect(closing).toContain("NEW");
    expect(closing).toContain("already open");
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
    expect(script).toContain("^\\s*LAZYIT_(TOKEN|URL)\\s*=");
    expect(script).toContain("Remove-Item -LiteralPath $StateDir");
  });

  // A PATH entry pointing at a directory that no longer exists is exactly the residue this path
  // exists to prevent — the argument #1137 made for the token and the state directory. It is
  // removed AFTER the directory, and like the install side it warns rather than aborting: a failure
  // here must not leave a half-uninstalled host, and the token has already gone by then.
  test("the PATH entry goes with the directory it points at (#1167)", () => {
    const removeDir = script.indexOf("Remove-Item -LiteralPath $InstallDir");
    // The CALL, not the function definition far above it.
    const removePath = script.indexOf("$pathRemoved = Remove-InstallDirFromPath");
    expect(removeDir).toBeGreaterThan(-1);
    expect(removePath).toBeGreaterThan(removeDir);
    const block = script.slice(removeDir, script.indexOf("if ($KeepConfig -and"));
    expect(block).toContain("Write-Warning");
    expect(block).not.toContain("Die ");
  });
});

/**
 * `-KeepToken`: A RE-RUN AUTHENTICATES WITH THE TOKEN THIS HOST ALREADY HAS (#1208).
 *
 * Re-running the installer is the documented upgrade path, and until now it demanded the Service
 * Account token on every run - which the server structurally cannot re-issue, because it stores only
 * a hash and a prefix. So "run this command again" was copy-paste PLUS go and find a secret. The
 * host already holds the token: this installer wrote it, into a file whose ACL is SYSTEM +
 * Administrators, and the script runs elevated. Reading back what it wrote is not a new exposure.
 *
 * HOW THIS IS TESTED. The extraction is a PURE function - config lines and a key in, the value out,
 * no path and no registry - for exactly the reason `Split-LazyitPath` is: that is what lets the
 * corpus below run through real PowerShell on a Linux CI runner, against the function read OUT OF
 * the shipped script. ONE extractor serves the token, the URL and the CA bundle, so the three
 * cannot drift apart in how they read a hand-edited file. The refusals around it cannot be executed
 * off Windows and are pinned as text, like every other branch in this file.
 */
type TokenCase = { lines: string[]; key?: string; token: string };

const TOKEN_CASES: Record<string, TokenCase> = {
  "a config that carries a token supplies it": {
    lines: ["LAZYIT_URL=https://lazyit.example.com", "LAZYIT_TOKEN=lzit_sa_abc"],
    token: "lzit_sa_abc",
  },
  // Get-Content splits on the newline and leaves the CR when the file has CRLF endings - which is
  // every file a Windows editor has touched. A trailing CR inside a bearer token is a 401 nobody can
  // explain from the message.
  "a trailing carriage return is not part of the token": {
    lines: ["LAZYIT_TOKEN=lzit_sa_abc\r"],
    token: "lzit_sa_abc",
  },
  "surrounding whitespace is not part of the token": {
    lines: ["  LAZYIT_TOKEN=  lzit_sa_abc  "],
    token: "lzit_sa_abc",
  },
  // The AGENT's own parser strips a matching pair of quotes, so a config it reads happily must not
  // be one this refuses - it would send the quotes as part of the credential.
  "a quoted value is unquoted, in either quote": {
    lines: ['LAZYIT_TOKEN="lzit_sa_abc"'],
    token: "lzit_sa_abc",
  },
  "a single-quoted value is unquoted too": {
    lines: ["LAZYIT_TOKEN='lzit_sa_abc'"],
    token: "lzit_sa_abc",
  },
  // The agent assigns key by key as it reads, so the LAST line is the one live on this host. An
  // installer that took the first would authenticate with a token the agent does not use.
  "the LAST token line wins, exactly as the agent's own parser resolves it": {
    lines: ["LAZYIT_TOKEN=lzit_sa_old", "LAZYIT_TOKEN=lzit_sa_new"],
    token: "lzit_sa_new",
  },
  "a token with '=' inside it survives - only the first '=' is the separator": {
    lines: ["LAZYIT_TOKEN=lzit_sa_a=b=c"],
    token: "lzit_sa_a=b=c",
  },
  "a config with no token line supplies nothing at all": {
    lines: ["LAZYIT_URL=https://lazyit.example.com", "LAZYIT_COLLECT_NICS=false"],
    token: "",
  },
  "a commented-out token is not a token": {
    lines: ["#LAZYIT_TOKEN=lzit_sa_abc"],
    token: "",
  },
  "an empty file supplies nothing, rather than throwing under StrictMode": {
    lines: [],
    token: "",
  },
  "LAZYIT_TOKEN_FILE is a different key and is not read as one": {
    lines: ["LAZYIT_TOKEN_FILE=C:\\ProgramData\\lazyit-agent\\agent.token"],
    token: "",
  },
  // THE LINE THE AGENT ACCEPTS AND THE INSTALLER COULD NOT SEE. `readConfigFile` trims the key
  // before it compares, so `LAZYIT_TOKEN =lzit_sa_abc` authenticates every tick - while an
  // extractor that demanded `=` immediately after the key answered "this host has no token" and
  // refused the upgrade on a host that was reporting happily.
  "space between the key and the '=' does not hide it": {
    lines: ["LAZYIT_TOKEN =lzit_sa_abc"],
    token: "lzit_sa_abc",
  },
  "a tab between the key and the '=' does not hide it either": {
    lines: ["  LAZYIT_TOKEN\t=  lzit_sa_abc\r"],
    token: "lzit_sa_abc",
  },
  // The widening must not turn a neighbouring key into this one. `_` is not whitespace, so it does
  // not - and this is the case that says so out loud.
  "a padded LAZYIT_TOKEN_FILE is still not a token": {
    lines: ["LAZYIT_TOKEN_FILE =C:\\ProgramData\\lazyit-agent\\agent.token"],
    token: "",
  },
  // The URL and the CA bundle go through the SAME function, which is the point of generalising it.
  "the same extractor answers for the URL a re-run re-uses": {
    lines: ["LAZYIT_URL = https://lazyit.example.com", "LAZYIT_TOKEN=lzit_sa_abc"],
    key: "LAZYIT_URL",
    token: "https://lazyit.example.com",
  },
  // -cmatch, not -match: the agent reads `lazyit_ca_file` and `LAZYIT_CA_FILE` as two keys and
  // prefers the lowercase one, so this must not answer the wrong file for either spelling.
  "the CA bundle is read case-sensitively, in the spelling asked for": {
    lines: ["LAZYIT_CA_FILE=C:\\ProgramData\\lazyit-agent\\upper.pem"],
    key: "lazyit_ca_file",
    token: "",
  },
};

/** The shipped `Get-LazyitConfigValue`, run by real PowerShell over the corpus. */
function tokenAnswersFromPowerShell(shell: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "lazyit-install-ps1-token-"));
  const casesFile = join(dir, "cases.json");
  const driver = join(dir, "driver.ps1");
  writeFileSync(
    casesFile,
    JSON.stringify(
      Object.entries(TOKEN_CASES).map(([name, one]) => ({
        name,
        lines: one.lines,
        key: one.key ?? "LAZYIT_TOKEN",
      })),
    ),
  );
  writeFileSync(
    driver,
    [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      powershellFunction("Get-LazyitConfigValue"),
      "foreach ($case in (Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json)) {",
      "  [pscustomobject]@{",
      "    name = $case.name",
      "    token = [string](Get-LazyitConfigValue ([string[]] $case.lines) ([string] $case.key))",
      "  } | ConvertTo-Json -Compress",
      "}",
      "",
    ].join("\n"),
  );

  const run = Bun.spawnSync([shell, "-NoProfile", "-File", driver, casesFile]);
  const stdout = new TextDecoder().decode(run.stdout);
  expect(
    run.exitCode,
    `${shell} could not run the shipped Get-LazyitConfigValue:\n${new TextDecoder().decode(run.stderr)}`,
  ).toBe(0);

  const answers: Record<string, string> = {};
  for (const line of stdout.split("\n").filter((one) => one.trim() !== "")) {
    const parsed = JSON.parse(line) as { name: string; token: string | null };
    answers[parsed.name] = parsed.token ?? "";
  }
  return answers;
}

/** The same function, modelled - used only where there is no PowerShell to ask. */
function tokenAnswersFromModel(): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [name, one] of Object.entries(TOKEN_CASES)) {
    let found = "";
    const pattern = new RegExp(`^\\s*${one.key ?? "LAZYIT_TOKEN"}\\s*=(.*)$`);
    for (const line of one.lines) {
      const match = pattern.exec(line);
      if (match) found = match[1] ?? "";
    }
    found = found.trim();
    if (
      found.length >= 2 &&
      ((found.startsWith('"') && found.endsWith('"')) || (found.startsWith("'") && found.endsWith("'")))
    ) {
      found = found.slice(1, -1);
    }
    answers[name] = found;
  }
  return answers;
}

let memoisedTokens: Record<string, string> | undefined;
function tokenAnswers(): Record<string, string> {
  memoisedTokens ??= POWERSHELL ? tokenAnswersFromPowerShell(POWERSHELL) : tokenAnswersFromModel();
  return memoisedTokens;
}

describe("-KeepToken authenticates a re-run with the token already on disk (#1208)", () => {
  test("the extraction is a PURE function, so it can be run off Windows", () => {
    const body = powershellFunction("Get-LazyitConfigValue");
    expect(body).toContain("function Get-LazyitConfigValue([string[]] $Lines, [string] $Key)");
    // If it ever reaches for $ConfigFile itself, the corpus below stops testing the shipped logic.
    expect(body).not.toContain("$ConfigFile");
    // The operations the model mirrors, so the fallback engine is not asserting against a fantasy.
    expect(body).toContain("^\\s*$Key\\s*=(.*)$");
    expect(body).toContain("Trim()");
    // -cmatch and not -match, which is the one place PowerShell's defaults would diverge from the
    // agent: `-match` is case-insensitive and would read a `lazyit_token=` the agent never reads.
    expect(body).toContain("-cmatch");
  });

  for (const [name, expected] of Object.entries(TOKEN_CASES)) {
    test(name, () => {
      const answer = tokenAnswers()[name];
      expect(answer, `${name}: ${ENGINE} answered nothing`).toBeDefined();
      expect(answer, `${name}, answered by ${ENGINE}`).toBe(expected.token);
    });
  }

  test("-KeepToken is a switch on the parameter block, and it is documented", () => {
    expect(script).toContain("[switch] $KeepToken");
    expect(script).toContain(".PARAMETER KeepToken");
  });

  // A HARD ERROR, never a precedence rule - the same posture as the existing -Token / -TokenFile
  // pair. Two token sources on one command line is an operator who believes something about this run
  // that is not true, and picking one silently is how a host ends up authenticating with the
  // credential that was just rotated away.
  test("it refuses to share the run with any other token source", () => {
    // The switch NAMES ITSELF in the message, so an operator who typed -Upgrade is not told about a
    // switch they did not pass. `$rerun` is that name, resolved once where the two forms meet.
    expect(script).toContain("$rerun and -Token are mutually exclusive");
    expect(script).toContain("$rerun and -TokenFile are mutually exclusive");
    expect(script).toMatch(/\$rerun = if \(\$Upgrade\) \{ '-Upgrade' \} else \{ '-KeepToken' \}/);
    // Including the environment form, which is ambient rather than typed and is therefore the one a
    // silent precedence rule would hide behind.
    expect(script).toMatch(/\$rerun[^\n]*LAZYIT_TOKEN/);
  });

  // -KeepConfig keeps this host's limits through an uninstall; the TOKEN never survives one.
  // Accepting -KeepToken there - even as a no-op - would let an operator believe otherwise about a
  // live credential on a host they are decommissioning.
  test("-Uninstall -KeepToken is refused rather than quietly ignored", () => {
    const uninstall = script.slice(script.indexOf("if ($Uninstall) {"), script.indexOf("if ($KeepConfig)"));
    expect(uninstall).toContain("if ($KeepToken) { Die ");
    expect(uninstall).toMatch(/never survives an uninstall/i);
  });

  test("a config with no token in it STOPS the install - never a silent unauthenticated one", () => {
    expect(script).toContain("no LAZYIT_TOKEN");
    // The first-install forms are named, because that is the other way to arrive here.
    expect(script).toMatch(/-Token[^\n]*-TokenFile/);
  });

  test("the read happens only after elevation has been checked", () => {
    // The config's ACL is SYSTEM + Administrators, so a non-elevated run must be told THAT rather
    // than that its own instance has no install on it.
    const elevation = script.indexOf("WindowsBuiltInRole]::Administrator");
    const read = script.indexOf("Get-LazyitConfigValue ");
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(elevation);
  });

  test("the token still lands in the file the installer owns, written exactly once", () => {
    // -KeepToken changes where the token COMES FROM and nothing about who owns which key: the old
    // LAZYIT_TOKEN line is still dropped from the preserved set and written back once at the top, so
    // a re-run cannot leave two of them and hand the parser the choice.
    expect(script).toContain("^\\s*LAZYIT_(URL|TOKEN|INTERVAL)\\s*=");
    expect(script.split('$lines.Add("LAZYIT_TOKEN=$Token")').length - 1).toBe(1);
  });

  /*
   * THE ARGV EXPOSURE THIS PLATFORM NEVER HAD. install.sh spelled its downloads as
   * `-H "Authorization: Bearer $TOKEN"` on curl's command line, where `/proc/<pid>/cmdline` made a
   * live credential world-readable for the length of every install; it now pipes a curl config on
   * stdin instead. This installer was already clear: `Invoke-WebRequest` takes a HEADERS HASHTABLE
   * inside the same process, so the token never becomes an argument of anything. Pinning it means a
   * later "simplify" to `curl.exe` - which Windows 10 1803 and later do ship - cannot import the
   * defect that was just fixed on the other side.
   */
  test("the token is never an argument to anything - it goes in a headers hashtable", () => {
    expect(script).toContain("$headers = @{ Authorization = \"Bearer $Token\" }");
    expect(script).toContain("Headers         = $headers");
    expect(script).not.toMatch(/-H\s+["']?Authorization/);
    expect(script).not.toContain("curl.exe");
  });
});

/**
 * `-Upgrade`: A RE-RUN KEEPS THIS HOST'S WHOLE CONFIGURATION, NOT ONLY ITS TOKEN (#1208).
 *
 * The Windows half of the same form, and the same reasoning: a generated update command that has to
 * carry `-Url` re-pins every host to whatever origin the admin's browser was on - which under the
 * `lan` mode of ADR-0087 silently repoints a fleet - and carries no `-CaFile`. `-Upgrade` takes both
 * from `C:\ProgramData\lazyit-agent\config`, so the command needs neither.
 *
 * WHAT -CaFile DOES HERE, STATED RATHER THAN GLOSSED, because it differs from Linux and the
 * difference is already documented one screen up: `Invoke-WebRequest` offers no per-request CA
 * bundle, so re-using the host's bundle affects the AGENT's config and not this script's own
 * download. The switch is symmetric anyway - one flag, one meaning, both platforms - and the half
 * that bites a fleet, the URL, works identically.
 */
describe("-Upgrade re-runs a host from its own configuration (#1208)", () => {
  test("-Upgrade is a switch on the parameter block, and it is documented", () => {
    expect(script).toContain("[switch] $Upgrade");
    expect(script).toContain(".PARAMETER Upgrade");
    expect(script).toMatch(/\.EXAMPLE[\s\S]{0,400}-Upgrade\b/);
  });

  test("it contains -KeepToken rather than competing with it", () => {
    expect(script).toContain("if ($Upgrade) { $KeepToken = $true }");
  });

  // The re-pinning defect. The explicit parameter still wins, because retargeting a host at a moved
  // instance is a real thing to want - it just has to be TYPED rather than inherited from whoever
  // generated the command.
  test("the URL comes from the config when -Url was not passed, and never overrides it", () => {
    expect(script).toMatch(/if \(-not \$Url\)\s*\{\s*\$Url\s*=\s*Get-LazyitConfigValue/);
  });

  test("the CA bundle comes from the config too, lowercase first as the agent resolves it", () => {
    const read = script.indexOf("'lazyit_ca_file'");
    const fallback = script.indexOf("'LAZYIT_CA_FILE'");
    expect(read).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(read);
  });

  // NEVER A SILENT UNCONFIGURED INSTALL: a first install has nothing to re-use by definition, and a
  // config that carries no URL is refused by name rather than left to a confusing default.
  test("a config with no URL in it stops the run and names the key", () => {
    expect(script).toContain("no LAZYIT_URL");
    expect(script).toMatch(/no LAZYIT_URL[^\n]*-Url/);
  });

  test("a CA bundle that has moved since the install is named, not left to fail inside the download", () => {
    expect(script).toMatch(/LAZYIT_CA_FILE[^\n]*cannot be read|cannot be read[^\n]*LAZYIT_CA_FILE/);
  });

  test("-Uninstall -Upgrade is refused rather than quietly ignored", () => {
    const uninstall = script.slice(
      script.indexOf("if ($Uninstall) {"),
      script.indexOf("if ($KeepConfig)"),
    );
    expect(uninstall).toContain("if ($Upgrade) { Die ");
    expect(uninstall).toMatch(/never survives an uninstall/i);
  });

  /*
   * WHERE THIS WAVE MEETS THE HARDENING WAVE (#1190). An upgrade is an install, so it clears the
   * same two bars: the checksum is required and fail-closed, and plain http needs the explicit
   * opt-in. The http half is executed one describe down, on the gate's own block; this is the
   * checksum half, and it is structural because the integrity block cannot be reached off Windows.
   */
  test("an upgrade verifies the checksum on the same fail-closed path as a first install", () => {
    const upgradeBlock = script.indexOf("if ($Upgrade) {");
    const integrity = script.indexOf("# --- integrity: the digest, REQUIRED (#1190)");
    expect(upgradeBlock).toBeGreaterThan(-1);
    expect(integrity).toBeGreaterThan(upgradeBlock);
    // No branch in the integrity block is conditional on how this run got its settings.
    const block = script.slice(integrity, script.indexOf("# --- the scheduled task"));
    expect(block).not.toContain("$Upgrade");
    expect(block).not.toContain("$KeepToken");
    expect(block).toMatch(/Die "could not fetch the sha256/);
    expect(block).toMatch(/Die "checksum mismatch/);
  });
});

/**
 * A FAILURE MUST BE CHECKABLE BY A SCRIPT (#1191). The script runs under
 * `$ErrorActionPreference='Stop'`, which makes `Write-Error` ITSELF a terminating error — so the old
 * `Write-Error` + `exit 1` pair never reached its exit: every Die stopped on an unhandled error
 * record, and a fleet script checking `$LASTEXITCODE` saw a raw record instead of a clean code.
 * `throw` is the deliberate replacement: `powershell -File` and `-Command` both turn an uncaught
 * throw into process exit code 1, and — the reason it wins over `Write-Host` + `exit` — the
 * `& ([scriptblock]::Create((irm ...)))` form the Manual documents keeps an INTERACTIVE operator's
 * elevated console open on a mistyped token instead of slamming it shut.
 */
describe("Die produces a clean, script-checkable failure (#1191)", () => {
  test("it throws — Write-Error under 'Stop' never reaches an exit line", () => {
    const die = powershellFunction("Die");
    expect(die).toContain('throw "lazyit-agent install: $Message"');
    expect(die).not.toContain("Write-Error");
    expect(die).not.toContain("exit 1");
  });

  // EXECUTED where the harness allows (#1193 convention), same engine rule as the PATH corpus:
  // real PowerShell when the machine has one, and the text assertion above is the whole check when
  // it does not — never a test that silently does nothing.
  test(`an uncaught Die exits the interpreter with code 1 (checked by ${ENGINE})`, () => {
    if (!POWERSHELL) return; // the throw-shape test above is the model half
    const dir = mkdtempSync(join(tmpdir(), "lazyit-install-ps1-die-"));
    const driver = join(dir, "die.ps1");
    writeFileSync(
      driver,
      [
        // The same preferences the installer itself runs under — the exact combination that made
        // the old Write-Error shape unreachable.
        "$ErrorActionPreference = 'Stop'",
        "Set-StrictMode -Version Latest",
        powershellFunction("Die"),
        "Die 'the token is required'",
        "",
      ].join("\n"),
    );
    const run = Bun.spawnSync([POWERSHELL, "-NoProfile", "-File", driver]);
    expect(run.exitCode, "an uncaught throw must reach the caller as exit code 1").toBe(1);
    const stderr = new TextDecoder().decode(run.stderr);
    expect(stderr).toContain("lazyit-agent install: the token is required");
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

  // THE WOW64 MISDETECT THIS PINS (#1191). Inside a 32-bit PowerShell on x64 Windows —
  // exactly what RMM/deployment tools commonly spawn, the fleet-install vector — the variable
  // PROCESSOR_ARCHITECTURE answers 'x86': the PROCESS architecture, not the machine's. The first
  // cut gated on it alone, so a perfectly supported x64 host died with "unsupported architecture".
  test("the gate decides on the MACHINE architecture — PROCESSOR_ARCHITEW6432 is consulted (#1191)", () => {
    // PROCESSOR_ARCHITEW6432 exists only inside a WOW64 process and holds the real architecture;
    // Is64BitOperatingSystem is the belt for a host that exports neither.
    const w6432 = script.indexOf("PROCESSOR_ARCHITEW6432");
    const gate = script.indexOf("-ne 'AMD64'");
    expect(w6432).toBeGreaterThan(-1);
    expect(w6432).toBeLessThan(gate);
    expect(script).toContain("[Environment]::Is64BitOperatingSystem");
  });

  test("a 32-bit shell on x64 Windows is INSTRUCTED to relaunch, never refused as unsupported (#1191)", () => {
    // Proceeding from the WOW64 shell would install under the wrong Program Files (%ProgramFiles%
    // answers 'Program Files (x86)' there), so the shell is named as the problem and the exact
    // 64-bit interpreter to relaunch from is given: SysNative is how a 32-bit process reaches the
    // real System32.
    expect(script).toContain("[Environment]::Is64BitProcess");
    expect(script).toContain("SysNative\\WindowsPowerShell\\v1.0\\powershell.exe");
    // The instruction lives on its own branch, after the machine has been established as AMD64 —
    // an ARM64 host still gets the honest unsupported-architecture refusal.
    const wow64Branch = script.indexOf("[Environment]::Is64BitProcess");
    const unsupported = script.indexOf("unsupported architecture");
    expect(unsupported).toBeGreaterThan(-1);
    expect(wow64Branch).toBeGreaterThan(unsupported);
  });

  test("-Baseline is explicit because Windows has no /proc/cpuinfo to auto-detect from", () => {
    expect(script).toContain("$arch = if ($Baseline) { 'x64-baseline' } else { 'x64' }");
    // And it never silently substitutes the AVX2 build for the baseline one, which would trade a
    // clear install error for an illegal-instruction crash weeks later.
    expect(script).toContain("will not substitute the ordinary x64 build");
  });
});

/**
 * PLAIN HTTP IS AN EXPLICIT DECISION, NOT A DEFAULT (#1190).
 *
 * Three behaviours compounded: an http -Url was accepted silently, the executable AND its sha256
 * travelled over that same cleartext channel (so an on-path attacker serves a malicious PE with a
 * matching digest), and the http URL was persisted into the config — putting the SA token on the
 * wire in cleartext on every later report, indefinitely. ADR-0087's LAN reality means http stays
 * POSSIBLE, but behind an opt-in whose warning names what it costs.
 */
describe("plain http needs -AllowInsecureHttp, and the cost is named (#1190)", () => {
  /** The gate's block, located by its own heading comment. */
  const gate = () => {
    const block = script.slice(
      script.indexOf("# --- plain http is an explicit decision"),
      script.indexOf("[Net.ServicePointManager]"),
    );
    expect(block.length).toBeGreaterThan(0);
    return block;
  };

  test("-AllowInsecureHttp is a declared parameter", () => {
    expect(script).toMatch(/\[switch\] \$AllowInsecureHttp/);
  });

  test("http without the flag is a hard stop that names BOTH exposures", () => {
    const block = gate();
    // The refusal must say what cleartext costs: the executable that will run as SYSTEM, and the
    // token that is persisted with this URL and re-exposed on every report the host ever sends.
    //
    // IT NAMES WHERE THE URL CAME FROM rather than always saying "-Url" (#1208 review). Since
    // -Upgrade can take the URL off the host's own config, a refusal hard-coded to "-Url uses plain
    // http" would send an operator looking for a parameter they never passed. `$urlSource` is that
    // name, and it defaults to '-Url'.
    expect(block).toContain('Die "$urlSource uses plain http');
    expect(script).toContain("$urlSource = '-Url'");
    expect(block).toContain("SYSTEM");
    expect(block).toContain("token");
    expect(block).toContain("every report");
    expect(block).toContain("-AllowInsecureHttp");
  });

  /*
   * -Upgrade DOES NOT INHERIT THE OPT-IN, which is new surface neither wave tested. A host installed
   * with -AllowInsecureHttp carries `LAZYIT_URL=http://…` in its config, so a re-run that re-used it
   * would arrive at this gate with a cleartext URL nobody typed. Letting the file answer "yes,
   * cleartext is acceptable" on the operator's behalf is the same fail-open #1190 closed, one input
   * over — so the gate reads the RESOLVED url, which the -Upgrade block assigns strictly before it.
   */
  test("the gate reads the resolved url, so a re-used http URL still has to be opted into", () => {
    const upgradeAssigns = script.indexOf("$Url = Get-LazyitConfigValue");
    const gateAt = script.indexOf("# --- plain http is an explicit decision");
    expect(upgradeAssigns).toBeGreaterThan(-1);
    expect(upgradeAssigns).toBeLessThan(gateAt);
    // …and the gate tests $Url itself, not the parameter as it was bound.
    expect(gate()).toContain("if ($Url -match '^http://')");
  });

  test("with the flag, a loud warning still names both exposures", () => {
    const block = gate();
    expect(block).toContain("Write-Warning");
    expect(block).toContain("cleartext");
  });

  test("the gate sits before anything is downloaded", () => {
    const gateAt = script.indexOf("# --- plain http is an explicit decision");
    const download = script.indexOf('Invoke-LazyitDownload "/api/agent/download');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(download);
  });
});

describe("the out-of-band digest escape hatch (#1190)", () => {
  /** The integrity block, from its heading to the install of the verified file. */
  const integrity = () => {
    const block = script.slice(
      script.indexOf("# --- integrity:"),
      script.indexOf("New-Item -ItemType Directory -Path $InstallDir"),
    );
    expect(block.length).toBeGreaterThan(0);
    return block;
  };

  test("-Sha256 is a declared parameter, validated as 64 hex characters", () => {
    expect(script).toMatch(/\[string\] \$Sha256/);
    expect(integrity()).toContain("^[0-9a-fA-F]{64}$");
  });

  test("when passed, it replaces the fetch — the digest arrives on a channel the server does not control", () => {
    const block = integrity();
    expect(block).toContain("if ($Sha256)");
    expect(block).toContain("ToLowerInvariant()");
  });

  test("a failed or invalid digest fetch names -Sha256 as the way out, and removes the download", () => {
    const block = integrity();
    expect(block).toContain("pass -Sha256");
    // Every hard stop in the block cleans up the temp download first: the invalid -Sha256, the
    // failed fetch, the non-digest answer, and the mismatch.
    expect(block.split("Remove-Item -LiteralPath $tmpBin").length - 1).toBeGreaterThanOrEqual(4);
  });

  test("-RequireChecksum stays accepted for existing automation — it is simply the default now", () => {
    expect(script).toMatch(/\[switch\] \$RequireChecksum/);
  });
});

/**
 * THE INSTALLED BINARY MUST NOT KEEP THE USER-TEMP DACL (#1189).
 *
 * The exe is downloaded to %TEMP% — whose ACL grants the installing user's SID FullControl — and
 * moved into %ProgramFiles%. On the same volume a move is a rename and KEEPS the source DACL, so
 * the binary the Scheduled Task runs as SYSTEM every tick stayed writable by that user's
 * medium-integrity (non-elevated) processes: overwrite the file, get SYSTEM within one tick. The
 * config dir's ACL was carefully hardened; the binary's never was.
 *
 * Like the rest of this file, this asserts the SCRIPT's logic and ordering — Linux CI has no
 * Windows ACLs to execute, so the reset itself is proven by `icacls /reset`'s documented contract
 * ("replaces ACLs with default inherited ACLs"), not by observation here.
 */
describe("the installed binary carries the Program Files ACL, not the user-temp one (#1189)", () => {
  test("the ACL is reset to inherited-only right after the move, before anything is run or registered", () => {
    const move = script.indexOf("Move-Item -LiteralPath $tmpBin");
    const reset = script.indexOf("icacls.exe");
    const runCheck = script.indexOf("& $BinPath --help");
    expect(move).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(move);
    expect(reset).toBeLessThan(runCheck);
    expect(script).toContain("/reset");
  });

  test("a failed reset is fatal and removes the binary — a SYSTEM exe writable by a user is not an install", () => {
    const block = script.slice(script.indexOf("icacls.exe"), script.indexOf("& $BinPath --help"));
    expect(block).toContain("Die ");
    expect(block).toContain("Remove-Item -LiteralPath $BinPath");
  });

  test("re-running the installer heals an existing binary's ACL — the reset is unconditional (upgrade path)", () => {
    // The move replaces the binary on every run and the reset always follows it, so re-running the
    // installer — the documented upgrade path — repairs a host installed by the Move-Item era.
    const block = script.slice(
      script.indexOf("Move-Item -LiteralPath $tmpBin"),
      script.indexOf("& $BinPath --help"),
    );
    expect(block).not.toContain("if (Test-Path");
  });
});

/**
 * HYPERVISOR HOSTS: THE BANNER AND THE `-NoHypervisor` VETO (ADR-0095, #1217).
 *
 * The Windows half of the same operator surface install.sh grew: a Hyper-V host reports its guests
 * automatically - the AGENT re-detects the role on every run, so the installer configures NOTHING
 * for the ordinary case - and what the installer adds is one best-effort banner (informational
 * only, never fatal) plus `-NoHypervisor`, which writes the host-owner veto
 * `LAZYIT_COLLECT_HYPERVISOR=false` into the config. The veto rides the same merge every other
 * `LAZYIT_*` key rides, so it survives `-Upgrade`.
 */
describe("hypervisor hosts: the banner and -NoHypervisor (ADR-0095)", () => {
  test("-NoHypervisor is a switch on the parameter block, and it is documented", () => {
    expect(script).toContain("[switch] $NoHypervisor");
    expect(script).toContain(".PARAMETER NoHypervisor");
  });

  test("the switch writes the ACTIVE veto; without it only the commented invitation is written", () => {
    expect(script).toContain(
      "if ($NoHypervisor) { $lines.Add('LAZYIT_COLLECT_HYPERVISOR=false') } else { $lines.Add('#LAZYIT_COLLECT_HYPERVISOR=false') }",
    );
  });

  // The line lands BELOW the kept block on purpose: the agent reads the LAST assignment, so a
  // re-run WITH the switch beats whatever an older config carried - while without the switch the
  // commented form assigns nothing and a kept veto stays the live one.
  test("the veto line lands below the kept block, so the switch wins over a stale kept value", () => {
    const preservedAt = script.indexOf("foreach ($line in $preserved) { $lines.Add($line) }");
    const vetoAt = script.indexOf("$lines.Add('LAZYIT_COLLECT_HYPERVISOR=false')");
    expect(preservedAt).toBeGreaterThan(-1);
    expect(vetoAt).toBeGreaterThan(preservedAt);
  });

  // THE UPGRADE REGRESSION THAT MATTERS, decided by the shipped patterns (the same JS/.NET
  // engine-equivalence argument the -Url guard block makes): the keep pattern recognises an ACTIVE
  // veto - padded or not, exactly as the agent reads it - and NO owned pattern claims it, so the
  // merge carries it across a re-run instead of clobbering it with the commented template.
  test("an existing active veto survives the merge - kept, and owned by nobody (ADR-0095)", () => {
    const keep = script.match(/Where-Object \{ \$_ -match '([^']+)' \}/)?.[1];
    expect(keep, "install.ps1 no longer filters the previous config this way").toBeTruthy();
    // Every ^\s*…LAZYIT_… pattern in the script EXCEPT the keep pattern itself, whose wildcard
    // key class ([A-Z0-9_]+) is what recognises the veto on purpose: the two owned spellings of
    // the config merge, and the -KeepConfig strip pattern of the uninstall path.
    const owned = [...script.matchAll(/'(\^\\s\*\(?LAZYIT_[^']+)'/g)]
      .map((one) => one[1] as string)
      .filter((one) => !one.includes("[A-Z0-9_]"));
    expect(owned.length).toBeGreaterThan(0);
    for (const line of ["LAZYIT_COLLECT_HYPERVISOR=false", "LAZYIT_COLLECT_HYPERVISOR =false"]) {
      expect(new RegExp(keep as string).test(line), `the keep pattern must match: ${line}`).toBe(true);
      for (const pattern of owned) {
        expect(new RegExp(pattern).test(line), `${pattern} must not claim: ${line}`).toBe(false);
      }
    }
  });

  test("the detection is a guarded function asking for the vmms service, and it cannot throw", () => {
    const body = powershellFunction("Test-LazyitHyperVHost");
    expect(body).toContain("Get-Service");
    expect(body).toContain("'vmms'");
    // Twice guarded: SilentlyContinue answers $null for a missing service, and the catch absorbs a
    // platform with no service manager at all - a banner probe must never stop an install.
    expect(body).toContain("SilentlyContinue");
    expect(body).toContain("catch { return $false }");
  });

  // EXECUTED where the harness allows (#1193 convention), same engine rule as the PATH corpus: on
  // the Linux/macOS machines this suite runs on there is no vmms service to ask, and the honest
  // answer is $false - never a throw, which under $ErrorActionPreference='Stop' would have been
  // fatal in the installer.
  test(`the detection answers false rather than throwing where there is no vmms (${ENGINE})`, () => {
    if (!POWERSHELL) return; // the shape test above is the whole check without an interpreter
    const dir = mkdtempSync(join(tmpdir(), "lazyit-install-ps1-hyperv-"));
    const driver = join(dir, "hyperv.ps1");
    writeFileSync(
      driver,
      [
        // The same preferences the installer itself runs under.
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        powershellFunction("Test-LazyitHyperVHost"),
        "[pscustomobject]@{ hyperv = [bool](Test-LazyitHyperVHost) } | ConvertTo-Json -Compress",
        "",
      ].join("\n"),
    );
    const run = Bun.spawnSync([POWERSHELL, "-NoProfile", "-File", driver]);
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(run.stdout)) as { hyperv: boolean };
    if (process.platform !== "win32") expect(parsed.hyperv).toBe(false);
  }, 60_000);

  test("the banner sits before anything is downloaded, and it cannot stop the install", () => {
    const start = script.indexOf("# --- hypervisor detection banner");
    const download = script.indexOf('Say "downloading agent');
    expect(start).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(start).toBeLessThan(download);
    const block = script.slice(start, download);
    expect(block).toContain("Test-LazyitHyperVHost");
    expect(block).not.toContain("Die ");
  });

  test("the wording names Hyper-V, the guests and the way out - and the switch flips it", () => {
    expect(script).toContain("Detected: Hyper-V");
    expect(script).toContain("Disable with -NoHypervisor");
    expect(script).toContain("disabled by -NoHypervisor");
  });
});
