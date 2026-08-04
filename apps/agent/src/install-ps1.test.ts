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
 */
let memoised: Record<string, PathAnswer> | undefined;
function answers(): Record<string, PathAnswer> {
  memoised ??= POWERSHELL ? answersFromPowerShell(POWERSHELL) : answersFromModel();
  return memoised;
}

describe("the install directory lands on the machine PATH, once (#1167)", () => {

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
      const answer = answers()[name];
      expect(answer, `${name}: ${ENGINE} answered nothing`).toBeDefined();
      expect({ ...answer }, `${name}, answered by ${ENGINE}`).toEqual({
        dropped: expected.dropped,
        kept: expected.kept,
        joined: expected.joined,
      });
    });
  }
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
    expect(script).toContain("^\\s*LAZYIT_(TOKEN|URL)=");
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
