import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A contract test over `apps/web/public/install.sh` (#1137).
 *
 * It lives in `apps/agent` rather than beside the script because this is the only workspace with a
 * test runner that will look at it: `apps/web`'s suite is the framework-agnostic list-state helpers
 * (ADR-0012 defers frontend tests), and the installer is the agent's other half — it writes the unit
 * the agent runs under and picks the artifact the agent is.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. It parses the script with `sh -n` and asserts the content of
 * the two systemd unit heredocs and of the uninstall path. It does NOT execute the installer: that
 * needs root, systemd, `/etc` and a live instance. So this pins the unit *contract* — the sandboxing
 * a security review greps for, the jitter, the priorities, and that uninstall destroys the token —
 * against a later edit quietly dropping one. It is not a substitute for installing on a real host.
 */
const INSTALL_SH = join(import.meta.dir, "..", "..", "web", "public", "install.sh");
const script = await Bun.file(INSTALL_SH).text();

/**
 * The body of `cat > "$VAR" <<EOF ... EOF`, so a directive is asserted to be in the RIGHT unit
 * rather than merely somewhere in the file — the mistake that would let `Nice=19` land on the timer,
 * where it does nothing at all.
 */
function heredocFor(variable: string): string {
  const start = script.indexOf(`cat > "$${variable}" <<EOF\n`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + `cat > "$${variable}" <<EOF\n`.length;
  const end = script.indexOf("\nEOF\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return script.slice(bodyStart, end);
}

test("the script is valid POSIX shell (`sh -n`)", async () => {
  const proc = Bun.spawn(["sh", "-n", INSTALL_SH], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

describe("the service unit is sandboxed — the agent needs root, not everything root can do", () => {
  const service = heredocFor("SERVICE");

  // These five are free, they are what a security-conscious buyer greps a unit file for, and none of
  // them costs the agent anything it actually uses: it reads /proc, /sys and /etc, runs dmidecode and
  // the package managers, and writes only /var/lib/lazyit-agent.
  test.each([
    "NoNewPrivileges=yes",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "ProtectKernelTunables=yes",
    "ProtectControlGroups=yes",
  ])("[Service] carries %s", (directive) => {
    expect(service).toContain(directive);
  });

  test("ProtectSystem is NOT strict — the agent has to write /var/lib/lazyit-agent", () => {
    expect(service).not.toContain("ProtectSystem=strict");
  });

  test("the run stays out of the way of whatever the box is actually for", () => {
    expect(service).toContain("Nice=19");
    expect(service).toContain("IOSchedulingClass=idle");
  });

  test("the #1133 run ceiling is still there", () => {
    expect(service).toContain("RuntimeMaxSec=");
  });
});

describe("the timer is de-phased — a patch window must not become a thundering herd", () => {
  const timer = heredocFor("TIMER");

  test("[Timer] carries RandomizedDelaySec, set to a real duration", () => {
    expect(timer).toContain("RandomizedDelaySec=$JITTER");
    expect(script).toMatch(/^JITTER="\d+(s|min)"$/m);
  });

  test("the fixed tick and the reboot catch-up survive it", () => {
    expect(timer).toContain("OnUnitActiveSec=$TICK");
    expect(timer).toContain("Persistent=true");
  });

  test("Nice/IOSchedulingClass are NOT on the timer, where they would do nothing", () => {
    expect(timer).not.toContain("Nice=");
    expect(timer).not.toContain("IOSchedulingClass=");
  });
});

describe("uninstall — nobody deploys what they cannot cleanly remove", () => {
  test("`--uninstall` is an accepted argument", () => {
    expect(script).toContain("--uninstall)");
  });

  test("it stops and disables the timer before deleting anything", () => {
    expect(script).toMatch(/systemctl\s+disable\s+--now\s+lazyit-agent\.timer/);
  });

  test("it removes the binary, both units and the state directory", () => {
    expect(script).toContain('rm -f "$BIN_PATH"');
    expect(script).toContain('rm -f "$SERVICE" "$TIMER"');
    expect(script).toContain('rm -rf "$STATE_DIR"');
  });

  // The config file is where the SA token lives. An uninstall that leaves it behind leaves a working
  // credential on a decommissioned host, which is the one outcome uninstall must never have.
  test("the token never survives an uninstall — either the file goes, or the token line does", () => {
    expect(script).toContain('rm -f "$CONFIG_FILE"');
    expect(script).toContain("--keep-config");
    expect(script).toMatch(/LAZYIT_TOKEN=/);
  });
});

/**
 * THE SECOND DEFECT IN #1166, which install.sh shares with install.ps1 exactly. `--url` is the
 * instance BASE url; every request is built as `"$URL/api/..."`. A `--url https://host/install.sh`
 * therefore asks for `https://host/install.sh/api/agent/download?arch=...` and surfaces as a
 * download failure whose message names the token as a likely cause — sending the operator to rotate
 * a credential that was never wrong. The Windows operator hit it first; the shape is identical here.
 */
describe("--url is the instance BASE url, and a wrong one is named instead of blamed on the token (#1166)", () => {
  test("the address of this script is refused, and BEFORE anything is downloaded", () => {
    const guard = script.indexOf("not the address of this script");
    // The real curl, not the `--help` line that also names the path it appends.
    const download = script.indexOf('"$URL/api/agent/download');
    expect(guard).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(download);
  });

  test("an /api endpoint is refused too — the installer appends /api/agent/download itself", () => {
    expect(script).toContain("not an API endpoint");
  });

  test("the usage text shows the base-URL form and names the mistake", () => {
    expect(script).toContain("--url <base-url>");
    expect(script).toMatch(/NOT .*install\.sh/);
  });

  test("the guard runs on the value the flags produced, after the trailing slash is stripped", () => {
    const trim = script.indexOf('URL="${URL%/}"');
    const guard = script.indexOf("not the address of this script");
    expect(trim).toBeGreaterThan(-1);
    expect(trim).toBeLessThan(guard);
  });
});

/**
 * The same guard, RUN rather than grepped (#1171 review).
 *
 * Every assertion in the block above is a string match over the source, and that is exactly how two
 * defects shipped: `/install.sh*` reads like "the script anywhere" and means "the script as the
 * FIRST path segment", and `${URL%%/install.*}` reads like "drop the script" and means "drop from
 * the first `/install.` in the whole URL — including the one inside a host called
 * `install.example.com`", which answers `https:/`. A test that greps for those two strings is
 * green on both bugs. These execute the shipped script and read what the operator would read.
 *
 * WHY THIS IS SAFE TO EXECUTE. The URL guard sits before the `id -u` root check, which is before
 * every write, download and `systemctl` call, so a URL the guard accepts stops one line later with
 * "must run as root" and nothing has happened. That is also the signal for "accepted": there is no
 * other way to observe it without installing. To keep that true no matter who runs the suite, PATH
 * is prefixed with an `id` shim that reports uid 1000 — a developer or container running `bun test`
 * as root would otherwise fall THROUGH the root check and on into the install path, which downloads
 * and writes to /usr/local/bin and /etc.
 */
const SHIM_DIR = join(tmpdir(), `lazyit-install-sh-guard-${process.pid}`);

beforeAll(async () => {
  await mkdir(SHIM_DIR, { recursive: true });
  // Only `id` is shimmed. The guard itself shells out to `tr` (lowercasing the scheme) and the rest
  // of the script to `uname`, `curl` and friends, so the real PATH stays behind this one.
  await Bun.write(join(SHIM_DIR, "id"), '#!/bin/sh\nif [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi\n');
  await chmod(join(SHIM_DIR, "id"), 0o755);
});

afterAll(async () => {
  await rm(SHIM_DIR, { recursive: true, force: true });
});

/**
 * Runs a script with the given arguments under the `id` shim, and answers everything it said before
 * it stopped. `path` is the shipped installer everywhere except the `--keep-token` block below,
 * which needs its config file somewhere a test can write.
 */
async function runInstaller(
  path: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      LAZYIT_URL: "",
      LAZYIT_TOKEN: "",
      ...env,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Runs the installer with `--url <url>` and returns everything it said before it stopped. */
async function guard(url: string): Promise<{ code: number; stderr: string }> {
  return runInstaller(INSTALL_SH, ["--url", url, "--token", "lzit_sa_not_a_real_token"]);
}

/** The message the script prints when a URL got PAST the guard: the very next check is `id -u`. */
const PAST_THE_GUARD = "must run as root";

describe("the --url guard, executed against the shipped install.sh (#1166)", () => {
  test("the shim really does stand in for root, so 'accepted' means accepted", async () => {
    const { stderr } = await guard("https://lazyit.example.com");
    expect(stderr).toContain(PAST_THE_GUARD);
    expect(stderr).not.toContain("--url");
  });

  // FINDING 2. The fatal branch was anchored to the FIRST path segment, so the one deployment shape
  // the warning branch exists to protect — an instance mounted under a prefix by a stripping proxy —
  // is the one where the operator copies `https://it.example.com/lazyit/install.sh` out of the
  // browser and gets a warning, then the #1166 download failure the guard was written to prevent.
  test("the script is refused wherever it sits in the path, not only as the first segment", async () => {
    for (const url of [
      "https://it.example.com/install.sh",
      "https://it.example.com/lazyit/install.sh",
      "https://it.example.com/lazyit/install.ps1",
      "https://it.example.com/a/b/install.sh",
    ]) {
      const { code, stderr } = await guard(url);
      expect(stderr, url).toContain("not the address of this script");
      expect(code, url).toBe(1);
    }
  });

  test("a path that merely starts like this script is not mistaken for it", async () => {
    // `/install.shed` is not this script. The old `/install.sh*` glob said it was.
    const { stderr } = await guard("https://it.example.com/install.shed");
    expect(stderr).not.toContain("not the address of this script");
    expect(stderr).toContain("carries a path");
    expect(stderr).toContain(PAST_THE_GUARD);
  });

  // FINDING 3. The suggestion is pasted, so a wrong one is worse than none. Both of these stripped
  // from the first match in the WHOLE URL string, which is inside the host, and answered `https:/`.
  test("the suggested replacement is stripped by path, so a host label never truncates it", async () => {
    const script1 = await guard("https://install.example.com/install.sh");
    expect(script1.stderr).toContain("pass --url https://install.example.com instead");
    const api = await guard("https://api.example.com/api");
    expect(api.stderr).toContain("Pass --url https://api.example.com.");
  });

  test("the suggestion keeps the prefix a stripping proxy mounts the instance under", async () => {
    const { stderr } = await guard("https://it.example.com/lazyit/install.ps1");
    expect(stderr).toContain("pass --url https://it.example.com/lazyit instead");
  });

  // FINDING 4. `case` is case-sensitive and PowerShell's `-match` is not, so HTTPS://host installed
  // on Windows and was refused here. RFC 3986 section 3.1 makes the scheme case-insensitive and curl
  // agrees, so the two installers are aligned on accepting it — see install.ps1 for the same note.
  test("an uppercase scheme is accepted, exactly as install.ps1 accepts it", async () => {
    for (const url of ["HTTPS://lazyit.example.com", "Http://lazyit.example.com:8080"]) {
      const { stderr } = await guard(url);
      expect(stderr, url).not.toContain("starting with http:// or https://");
      expect(stderr, url).toContain(PAST_THE_GUARD);
    }
  });

  test("an uppercase scheme is still split into origin and path, so the guard keeps biting", async () => {
    const { stderr } = await guard("HTTPS://it.example.com/lazyit/install.sh");
    expect(stderr).toContain("pass --url HTTPS://it.example.com/lazyit instead");
  });

  test("no scheme at all is refused by name, not left to fail inside curl", async () => {
    const { code, stderr } = await guard("192.168.100.75:8080");
    expect(stderr).toContain("starting with http:// or https://");
    expect(code).toBe(1);
  });

  test("an /api endpoint is refused, because the installer appends /api/agent/download itself", async () => {
    for (const url of ["https://it.example.com/api", "https://it.example.com/api/agent/download"]) {
      const { code, stderr } = await guard(url);
      expect(stderr, url).toContain("not an API endpoint");
      expect(code, url).toBe(1);
    }
  });

  // Any OTHER path only warns, for the same reason as in install.ps1: lazyit sets no basePath, so a
  // path is almost always one of the mistakes above wearing a different shape, but a prefix-stripping
  // reverse proxy really can mount an instance under one and re-running this script IS the
  // documented upgrade path. The `die` branches are the cases that can never be a valid base.
  test("any other path WARNS and continues, so a prefix-stripping proxy still installs", async () => {
    const { stderr } = await guard("https://it.example.com/lazyit");
    expect(stderr).toContain("carries a path (/lazyit)");
    expect(stderr).toContain(PAST_THE_GUARD);
  });
});

describe("artifact selection — a SIGILL months after a vMotion is not an acceptable failure", () => {
  test("a host without AVX2 gets the baseline build", () => {
    expect(script).toContain("x64-baseline");
    expect(script).toMatch(/avx2/);
  });

  // NOT a hardcoded glibc version. The issue that asked for this named 2.29, but the artifacts this
  // repo builds today link no symbol newer than GLIBC_2.17 — a number in the script would have been
  // both wrong now and stale at the next Bun bump. The installer runs the binary instead.
  test("the host's ability to RUN the binary is proven before a unit is written", () => {
    expect(script).toContain('"$BIN_PATH" --help');
    const runCheck = script.indexOf('"$BIN_PATH" --help');
    const firstUnit = script.indexOf('cat > "$SERVICE"');
    expect(runCheck).toBeGreaterThan(-1);
    expect(runCheck).toBeLessThan(firstUnit);
  });

  test("a binary that will not start is removed again, leaving the host as it was", () => {
    expect(script).toMatch(/rm -f "\$BIN_PATH"\n\s*die "the agent binary will not start/);
  });

  test("no hardcoded glibc version — the check is evidence, not a guess", () => {
    expect(script).not.toContain("2.29");
  });
});

describe("integrity — TLS and four bytes of ELF magic were the whole check", () => {
  test("the installer fetches a published digest and compares it", () => {
    expect(script).toContain("/api/agent/checksum");
    expect(script).toMatch(/sha256/i);
  });

  test("a digest MISMATCH is fatal, never a warning", () => {
    expect(script).toMatch(/die "checksum mismatch/);
  });

  test("--require-checksum exists for an operator who wants a missing digest to be fatal too", () => {
    expect(script).toContain("--require-checksum");
  });
});

describe("the token stays out of argv where it can", () => {
  test("--token-file is accepted, and `-` reads stdin", () => {
    expect(script).toContain("--token-file");
    expect(script).toMatch(/TOKEN_FILE/);
  });

  test("LAZYIT_TOKEN in the environment is the third safe form", () => {
    expect(script).toContain('TOKEN="${TOKEN:-${LAZYIT_TOKEN:-}}"');
  });

  // The help says `--token-file -` cannot be combined with `curl | sh`. That is a promise, and
  // without this the code would break it silently: under the pipe, stdin IS the rest of the script,
  // `cat` reads it, and a few kilobytes of shell get sent as a bearer token.
  test("a stdin read that produced shell rather than a token is caught and named", () => {
    expect(script).toMatch(/\*\[\[:space:\]\]\*\)/);
    expect(script).toMatch(/die "what was read from .* is not a token/);
  });
});

describe("private CA — the Manual used to say 'trust it system-wide', which is worse", () => {
  // The AGENT reading LAZYIT_CA_FILE is only half of it: install.sh's own download runs through
  // curl, which uses the system trust store. Without --cacert here, a LAN self-signed instance
  // would still force a system-wide trust decision just to get the binary onto the host.
  test("--ca-file is passed to curl, not only written into the config", () => {
    expect(script).toContain("--ca-file");
    expect(script).toContain('CURL_CA="--cacert $CA_FILE"');
    expect(script.match(/curl -fsSL --max-redirs 0 \$CURL_CA /g) ?? []).toHaveLength(2);
  });

  // The behaviour this pattern buys is executed in "a re-install must not delete a setting the agent
  // actually reads" below; this only pins that the CA key joins the owned set at all.
  test("it reaches the agent too, and replaces rather than duplicates an existing key", () => {
    expect(script).toContain("LAZYIT_CA_FILE=$CA_FILE");
    expect(script).toContain("LAZYIT_(URL|TOKEN|INTERVAL|CA_FILE)");
  });
});

/**
 * RE-INSTALL PRESERVATION, run rather than pattern-matched (#1137, and the same class of erasure
 * #1160 fixed on the local veto).
 *
 * Re-running the installer is the documented upgrade path and it rewrites `/etc/lazyit-agent/config`
 * wholesale, so anything the preservation pipeline does not match is DELETED from a working host.
 * These tests execute the script's own two `grep -E` stages against a fixture, because the bug this
 * covers was a regex that read plausibly and matched the wrong half of what `networkFrom` honours.
 */
describe("a re-install must not delete a setting the agent actually reads", () => {
  /** The keep-pattern, lifted out of the script so the test cannot drift from what runs. */
  const KEEP_PATTERN = script.match(/KEPT="\$\(grep -E '([^']+)'/)?.[1];
  /** The installer-owned pattern, in both its forms: without `--ca-file`, and with it. */
  const ownedPatterns = [...script.matchAll(/^[ \t]*OWNED='([^']+)'$/gm)].map(
    (m) => m[1] as string,
  );

  /** Run the installer's real pipeline over a fixture config; answer the lines it would keep. */
  async function preserved(config: string, owned: string): Promise<string[]> {
    expect(KEEP_PATTERN).toBeTruthy();
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        `grep -E '${KEEP_PATTERN}' | grep -Ev "^[[:space:]]*${owned}" || true`,
      ],
      { stdin: new TextEncoder().encode(config), stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    return out.split("\n").filter((l) => l.length > 0);
  }

  test("the script still has both stages and both OWNED spellings", () => {
    expect(KEEP_PATTERN).toBeTruthy();
    expect(ownedPatterns).toHaveLength(2);
  });

  // `networkFrom` reads `https_proxy` exactly as it reads `HTTPS_PROXY` — the config template and
  // the Manual both invite the file — so a pattern that matches only the UPPERCASE spelling deletes
  // a documented, working proxy on the upgrade path, with nothing on screen to say so.
  test("the LOWERCASE proxy spellings survive, because the agent honours them", async () => {
    const kept = await preserved(
      [
        "https_proxy=http://proxy.corp:3128",
        "http_proxy=http://proxy.corp:3128",
        "no_proxy=lazyit.corp,.internal",
        "lazyit_ca_file=/etc/pki/corp-root.pem",
      ].join("\n"),
      ownedPatterns[0] as string,
    );
    expect(kept).toEqual([
      "https_proxy=http://proxy.corp:3128",
      "http_proxy=http://proxy.corp:3128",
      "no_proxy=lazyit.corp,.internal",
      "lazyit_ca_file=/etc/pki/corp-root.pem",
    ]);
  });

  test("the UPPERCASE spellings and the local veto still survive too", async () => {
    const kept = await preserved(
      [
        "HTTPS_PROXY=http://proxy.corp:3128",
        "NO_PROXY=.internal",
        "LAZYIT_COLLECT_SOFTWARE=false",
        "LAZYIT_MIN_INTERVAL=3600",
      ].join("\n"),
      ownedPatterns[0] as string,
    );
    expect(kept).toHaveLength(4);
  });

  test("the installer-owned keys are still dropped — the flags supply them fresh", async () => {
    const kept = await preserved(
      ["LAZYIT_URL=https://old.example.com", "LAZYIT_TOKEN=stale", "LAZYIT_INTERVAL=900"].join("\n"),
      ownedPatterns[0] as string,
    );
    expect(kept).toEqual([]);
  });

  // Passing --ca-file means "this is the CA now", so the old line must go rather than be written a
  // second time and leave which one wins to the parser — in EITHER spelling, since both are read.
  test("--ca-file replaces an existing CA line in either spelling", async () => {
    const kept = await preserved(
      ["LAZYIT_CA_FILE=/old/upper.pem", "lazyit_ca_file=/old/lower.pem", "no_proxy=.internal"].join(
        "\n",
      ),
      ownedPatterns[1] as string,
    );
    expect(kept).toEqual(["no_proxy=.internal"]);
  });

  test("a line that is not a config key at all is not carried over", async () => {
    const kept = await preserved(
      ["# a comment about HTTPS_PROXY", "PATH=/usr/bin", "", "SOMETHING_ELSE=1"].join("\n"),
      ownedPatterns[0] as string,
    );
    expect(kept).toEqual([]);
  });

  // `--keep-token` (#1208) changes where the token COMES FROM, and nothing about who owns which key.
  // The old LAZYIT_TOKEN line is still dropped here and written back once at the top of the file, so
  // a re-run cannot leave two of them and hand the parser the choice - while the host owner's veto
  // survives the upgrade exactly as it did before.
  test("--keep-token does not widen the owned set: the veto survives, the token is written once", async () => {
    const kept = await preserved(
      [
        "LAZYIT_URL=https://lazyit.example.com",
        "LAZYIT_TOKEN=lzit_sa_already_here",
        "LAZYIT_COLLECT_SOFTWARE=false",
        "https_proxy=http://proxy.corp:3128",
      ].join("\n"),
      ownedPatterns[0] as string,
    );
    expect(kept).toEqual(["LAZYIT_COLLECT_SOFTWARE=false", "https_proxy=http://proxy.corp:3128"]);
  });
});

/**
 * `--keep-token`: A RE-RUN AUTHENTICATES WITH THE TOKEN THIS HOST ALREADY HAS (#1208).
 *
 * Re-running the installer is the documented upgrade path, and until now it demanded the Service
 * Account token on every run - which the server structurally cannot re-issue, because it stores only
 * a hash and a prefix. So "run this command again" was copy-paste PLUS go and find a secret.
 *
 * WHAT IS AND IS NOT EXECUTED HERE. The extraction itself is the shipped `config_token` function,
 * lifted out of the script and run over a corpus - the same trick `install-ps1.test.ts` plays on its
 * two PATH functions, and the reason that function takes stdin and touches no path. The end-to-end
 * cases run the WHOLE script: the refusals against the shipped file, and the two that need a config
 * file against a copy whose `CONFIG_DIR` line - and only that line - names a temp directory, because
 * the real one is `/etc/lazyit-agent` and a test cannot write there.
 */
describe("--keep-token authenticates a re-run with the token already on disk (#1208)", () => {
  /** A complete `name() { ... }` definition, read out of the shipped installer. */
  function shellFunction(name: string): string {
    const start = script.indexOf(`\n${name}() {\n`);
    expect(start, `install.sh defines no function ${name}`).toBeGreaterThan(-1);
    const end = script.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return script.slice(start + 1, end + 2);
  }

  /** The shipped `config_token`, run by a real shell over one fixture config. */
  async function configToken(config: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", `set -eu\n${shellFunction("config_token")}\nconfig_token`], {
      stdin: new TextEncoder().encode(config),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr, "config_token wrote to stderr").toBe("");
    expect(code, "config_token exited non-zero").toBe(0);
    return stdout;
  }

  test("config_token is PURE - stdin in, the token out, no path and no root", () => {
    const body = shellFunction("config_token");
    // If it ever reaches for "$CONFIG_FILE" itself, the corpus below stops testing the shipped
    // logic and the function stops being runnable anywhere but a host with an install on it.
    expect(body).not.toContain("$CONFIG_FILE");
  });

  test("a config that carries a token supplies it", async () => {
    expect(
      await configToken("LAZYIT_URL=https://lazyit.example.com\nLAZYIT_TOKEN=lzit_sa_abc\n"),
    ).toBe("lzit_sa_abc");
  });

  // The installer writes this file, but an operator edits it - and a file that has been through a
  // Windows editor comes back with CRLF. A trailing CR inside a bearer token is a 401 nobody can
  // explain from the message. The quoted forms are what the AGENT's own parser accepts, so a config
  // it reads happily must not be one this refuses.
  test("a CRLF file, surrounding space and a quoted value all yield the bare token", async () => {
    expect(await configToken("LAZYIT_TOKEN=lzit_sa_abc\r\n")).toBe("lzit_sa_abc");
    expect(await configToken("  LAZYIT_TOKEN=  lzit_sa_abc  \n")).toBe("lzit_sa_abc");
    expect(await configToken('LAZYIT_TOKEN="lzit_sa_abc"\n')).toBe("lzit_sa_abc");
    expect(await configToken("LAZYIT_TOKEN='lzit_sa_abc'\n")).toBe("lzit_sa_abc");
  });

  // The agent's own parser assigns key by key as it reads, so the LAST line is the one that is live
  // on this host. An installer that authenticated with the first would use a token the agent does
  // not - and report success while the timer kept failing.
  test("the LAST token line wins, exactly as the agent's own parser resolves it", async () => {
    expect(await configToken("LAZYIT_TOKEN=lzit_sa_old\nLAZYIT_TOKEN=lzit_sa_new\n")).toBe(
      "lzit_sa_new",
    );
  });

  test("a token with '=' inside it survives - only the first '=' is the separator", async () => {
    expect(await configToken("LAZYIT_TOKEN=lzit_sa_a=b=c\n")).toBe("lzit_sa_a=b=c");
  });

  test("a config with no token line - or a commented-out one - supplies nothing at all", async () => {
    expect(
      await configToken("LAZYIT_URL=https://lazyit.example.com\nLAZYIT_COLLECT_NICS=false\n"),
    ).toBe("");
    expect(await configToken("#LAZYIT_TOKEN=lzit_sa_abc\n")).toBe("");
    expect(await configToken("")).toBe("");
    // Not this key. `LAZYIT_TOKEN_FILE` is not a token and must not be read as one.
    expect(await configToken("LAZYIT_TOKEN_FILE=/root/agent.token\n")).toBe("");
  });

  /**
   * The shipped script with ONE line changed - `CONFIG_DIR` - so the fixture config can live where a
   * test can write it. Everything else is byte for byte the installer that ships, and the
   * substitution is asserted to have happened exactly once, so a rename cannot turn these two cases
   * into a copy of the script quietly testing nothing.
   */
  async function installerWithConfigIn(dir: string): Promise<string> {
    const original = 'CONFIG_DIR="/etc/lazyit-agent"';
    expect(script.split(original).length - 1, "install.sh no longer sets CONFIG_DIR this way").toBe(1);
    const copy = join(dir, "install.sh");
    await writeFile(copy, script.replace(original, `CONFIG_DIR="${dir}"`));
    return copy;
  }

  /** A config file shaped like the one the installer writes, with this host's own veto in it. */
  const EXISTING_CONFIG = [
    "# lazyit reporting agent config (ADR-0074). Holds your instance URL + SA token. chmod 600.",
    "LAZYIT_URL=https://lazyit.example.com",
    "LAZYIT_TOKEN=lzit_sa_already_here",
    "LAZYIT_COLLECT_SOFTWARE=false",
    "",
  ].join("\n");

  // THE CASE THE ISSUE ASKED FOR. No `--token`, no `--token-file`, no `LAZYIT_TOKEN` - and the run
  // gets PAST the token requirement, all the way to the root check, which is the next thing that
  // stops it. That is the whole feature: an upgrade needs no secret on the command line.
  test("a re-run with NO token argument gets through, because the config supplies one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyit-keep-token-"));
    try {
      await writeFile(join(dir, "config"), EXISTING_CONFIG);
      const { stdout, stderr } = await runInstaller(await installerWithConfigIn(dir), [
        "--url",
        "https://lazyit.example.com",
        "--keep-token",
      ]);
      expect(stderr).toContain(PAST_THE_GUARD);
      expect(stderr).not.toContain("a token is required");
      // …and it says which token it used, without printing it. An installer that silently changes
      // where a credential comes from is exactly what this flag exists to avoid being.
      expect(stdout + stderr).toContain("--keep-token");
      expect(stdout + stderr).not.toContain("lzit_sa_already_here");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // …and the "only when" half: the same run against a config with no token in it must STOP, with a
  // message an operator can act on. A silent unauthenticated install is the one outcome this must
  // never have.
  test("the same re-run STOPS when the config carries no token, and says what to do", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyit-keep-token-"));
    try {
      await writeFile(
        join(dir, "config"),
        "LAZYIT_URL=https://lazyit.example.com\nLAZYIT_COLLECT_NICS=false\n",
      );
      const { code, stderr } = await runInstaller(await installerWithConfigIn(dir), [
        "--url",
        "https://lazyit.example.com",
        "--keep-token",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("no LAZYIT_TOKEN");
      expect(stderr).toContain("--token");
      expect(stderr).not.toContain(PAST_THE_GUARD);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The ordinary first install on a host that never had the agent. The message names root FIRST,
  // because the file is 0600 and "I forgot sudo" is the likelier of the two ways to get here.
  test("no readable config is an actionable refusal naming root and the first-install forms", async () => {
    const { code, stderr } = await runInstaller(INSTALL_SH, [
      "--url",
      "https://lazyit.example.com",
      "--keep-token",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("/etc/lazyit-agent/config");
    expect(stderr).toContain("as root");
    expect(stderr).toContain("--token-file");
    expect(stderr).not.toContain(PAST_THE_GUARD);
  });

  // A HARD ERROR, never a precedence rule. Two token sources on one command line is an operator who
  // believes something about this run that is not true, and picking one silently is how a host ends
  // up authenticating with the credential that was just rotated away.
  test.each([
    [["--token", "lzit_sa_passed"], {}],
    [["--token-file", "/root/agent.token"], {}],
    [[], { LAZYIT_TOKEN: "lzit_sa_from_the_environment" }],
  ] as [string[], Record<string, string>][])(
    "--keep-token refuses to share the run with another token source (%p)",
    async (args, env) => {
      const { code, stderr } = await runInstaller(
        INSTALL_SH,
        ["--url", "https://lazyit.example.com", "--keep-token", ...args],
        env,
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--keep-token");
      expect(stderr).toMatch(/pass one|mutually exclusive/);
      expect(stderr).not.toContain(PAST_THE_GUARD);
    },
  );

  // `--keep-config` keeps this host's limits through an uninstall; the TOKEN never survives one.
  // Accepting `--keep-token` there - even as a no-op - would let an operator believe otherwise about
  // a live credential on a host they are decommissioning.
  test("--uninstall --keep-token is refused rather than quietly ignored", async () => {
    const { code, stderr } = await runInstaller(INSTALL_SH, ["--uninstall", "--keep-token"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--keep-token");
    expect(stderr).toContain("--uninstall");
  });

  test("without --keep-token, a run with no token still fails exactly as it always did", async () => {
    const { code, stderr } = await runInstaller(INSTALL_SH, ["--url", "https://lazyit.example.com"]);
    expect(code).toBe(1);
    expect(stderr).toContain("a token is required");
  });

  test("the usage text documents it, and names it as the re-run form", () => {
    expect(script).toContain("--keep-token");
    expect(script).toMatch(/--keep-token\s+.*re-run/i);
  });
});
