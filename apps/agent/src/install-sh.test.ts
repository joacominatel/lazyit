import { describe, expect, test } from "bun:test";
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
    const download = script.indexOf("/api/agent/download");
    expect(guard).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(download);
    // Both installers are named: an operator working from the Windows one-liner passes
    // /install.ps1 to this script just as easily as the other way round.
    expect(script).toContain("/install.sh*|/install.ps1*)");
  });

  test("it suggests the URL the operator meant, rather than only rejecting the one they typed", () => {
    expect(script).toContain("${URL%%/install.*}");
  });

  test("an /api endpoint is refused too — the installer appends /api/agent/download itself", () => {
    expect(script).toContain("/api|/api/*)");
    expect(script).toContain("not an API endpoint");
  });

  test("a --url with no scheme is refused by name, not left to fail inside curl", () => {
    expect(script).toContain("http://*|https://*)");
    expect(script).toContain("starting with http:// or https://");
  });

  // Any OTHER path only warns, for the same reason as in install.ps1: lazyit sets no basePath, so a
  // path is almost always the mistake above wearing a different shape, but a prefix-stripping
  // reverse proxy really can mount an instance under one and re-running this script IS the
  // documented upgrade path. The two `die` branches are the cases that can never be a valid base.
  test("any other path WARNS and continues, so a prefix-stripping proxy still installs", () => {
    expect(script).toContain("carries a path");
    expect(script).toMatch(/URL_PATH.*\n?.*lazyit is served from the root/);
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
});
