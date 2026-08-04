import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The agent's version stamp, end to end minus Docker (#1203).
 *
 * THE BUG THIS GUARDS. Every image-built agent reported `agentVersion: "dev"` instead of the release
 * tag, because `infra/docker/api.Dockerfile`'s `agent-builder` stage never declared `ARG APP_VERSION`
 * — a build arg is scoped to the stage that declares it, and `.dockerignore` excludes `.git`, so the
 * compile script's `git describe` fallback found nothing and stamped `dev`. That silently disabled a
 * SHIPPED feature: `isMajorBehind("dev", <server>)` is fail-soft `false` (ADR-0083 amendment / #907),
 * so the "Agent outdated" badge could never fire and `agentSkew.agentAhead` was always false.
 *
 * WHAT THESE TESTS PROVE AND WHAT THEY DO NOT. Two halves:
 *
 *  1. The MECHANISM, executed for real: `bun build --define process.env.APP_VERSION=...` over this
 *     app's own entry point, then the bundle is run and asked for its version. `--compile` is skipped
 *     (five ~100 MB cross-compiled artifacts is not a unit test); `--define` is the same substitution
 *     the `compile:*` scripts pass, applied to the same `src/index.ts`.
 *  2. The PLUMBING, statically: that the build arg is actually declared where the compile runs, and
 *     is fed to it by compose and by the two operator scripts.
 *
 * Only a real image build proves the whole chain end to end (a `docker build --build-arg APP_VERSION=…`
 * followed by `lazyit-agent --help` inside the image). These tests pin every link that is reachable
 * without a Docker daemon, which is exactly the link that broke.
 *
 * `dev` REMAINS VALID. An agent built from a source checkout with no tag legitimately reports `dev`,
 * and both sides treat it as "never behind" on purpose. The last test pins that fallback so a future
 * change cannot "fix" it into something that nags every development build.
 */
const AGENT_DIR = join(import.meta.dir, "..");
const REPO_ROOT = join(AGENT_DIR, "..", "..");
const ENTRY = join(import.meta.dir, "index.ts");

const STAMPED = "v9.9.9-stamp-test";

const { scripts } = (await Bun.file(join(AGENT_DIR, "package.json")).json()) as {
  scripts: Record<string, string>;
};

let workDir = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "lazyit-agent-version-stamp-"));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

/** Bundle `src/index.ts` the way the compile scripts do, with or without the `--define` stamp. */
async function bundle(name: string, version?: string): Promise<string> {
  const outfile = join(workDir, name);
  const args = ["bun", "build", "--target=bun"];
  if (version !== undefined) {
    args.push("--define", `process.env.APP_VERSION=${JSON.stringify(version)}`);
  }
  args.push("--outfile", outfile, ENTRY);

  const proc = Bun.spawn(args, { cwd: AGENT_DIR, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).not.toContain("error");
  expect(code).toBe(0);
  return outfile;
}

/**
 * The first line of `--help` is `lazyit-agent <version> — …`, built from the same `AGENT_VERSION`
 * constant the report's `agentVersion` field carries. `--help` returns before any config write,
 * any state directory and any network call.
 */
async function versionOf(outfile: string, env: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn(["bun", outfile, "--help"], {
    cwd: workDir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  const first = stdout.split("\n")[0] ?? "";
  const match = /^lazyit-agent (\S+) /.exec(first);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("the build-time version stamp", () => {
  test("a stamped build reports the version it was built with, not 'dev'", async () => {
    const outfile = await bundle("stamped.js", STAMPED);
    expect(await versionOf(outfile, { APP_VERSION: undefined })).toBe(STAMPED);
  }, 60_000);

  test("the stamp is baked in — the reporting host's environment cannot rewrite it", async () => {
    // `--define` substitutes the literal at build time, so a stray APP_VERSION on the monitored
    // server (or in a systemd unit) cannot make a node claim a version it is not running.
    const outfile = await bundle("stamped-env.js", STAMPED);
    expect(await versionOf(outfile, { APP_VERSION: "v0.0.0-ambient" })).toBe(STAMPED);
  }, 60_000);

  test("an unstamped build still falls back to 'dev' (the fail-soft value stays valid)", async () => {
    const outfile = await bundle("unstamped.js");
    expect(await versionOf(outfile, { APP_VERSION: undefined })).toBe("dev");
  }, 60_000);
});

describe("the compile scripts pass the stamp", () => {
  const compileTargets = Object.keys(scripts).filter((s) => s.startsWith("compile:"));

  test("there is at least one compile target to check", () => {
    expect(compileTargets.length).toBeGreaterThan(0);
  });

  test.each(compileTargets)("%s bakes APP_VERSION and keeps the dev fallback", (target) => {
    const script = scripts[target] ?? "";
    expect(script).toContain("--define process.env.APP_VERSION=");
    // The env var WINS (that is the release build's injection point) and the git/`dev` chain is the
    // fallback for a source checkout — the order matters, so the whole expansion is pinned.
    expect(script).toContain(
      "${APP_VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}",
    );
  });
});

describe("the image build feeds the stamp to the agent compile", () => {
  let agentStage = "";

  beforeAll(async () => {
    const dockerfile = await Bun.file(join(REPO_ROOT, "infra", "docker", "api.Dockerfile")).text();
    const start = dockerfile.indexOf("FROM builder AS agent-builder");
    expect(start).toBeGreaterThan(-1);
    const next = dockerfile.indexOf("\nFROM ", start + 1);
    agentStage = next === -1 ? dockerfile.slice(start) : dockerfile.slice(start, next);
  });

  test("the agent-builder stage declares ARG APP_VERSION", () => {
    // Scoped to THIS stage: the `runtime` stage's ARG (which stamps the API) does nothing for a
    // binary compiled three stages earlier. That gap was #1203.
    expect(agentStage).toMatch(/^ARG APP_VERSION/m);
  });

  test("the ARG is declared before the compile runs", () => {
    const arg = agentStage.search(/^ARG APP_VERSION/m);
    const compile = agentStage.indexOf("bun run --filter @lazyit/agent compile");
    expect(compile).toBeGreaterThan(-1);
    expect(arg).toBeGreaterThan(-1);
    expect(arg).toBeLessThan(compile);
  });

  test("compose passes the checkout's version as the api build arg", async () => {
    const compose = await Bun.file(join(REPO_ROOT, "compose.yaml")).text();
    expect(compose).toContain("APP_VERSION: ${LAZYIT_VERSION:-dev}");
  });

  test.each(["start.sh", "update.sh"])(
    "infra/%s exports LAZYIT_VERSION for that build arg",
    async (script) => {
      const text = await Bun.file(join(REPO_ROOT, "infra", script)).text();
      expect(text).toContain("export LAZYIT_VERSION");
    },
  );
});
