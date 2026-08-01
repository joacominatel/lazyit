import { describe, expect, test } from "bun:test";
import { AGENT_POLICY_DEFAULT, type AgentPolicy } from "@lazyit/shared";
import { applyDiskPolicy, applyNicPolicy, applySoftwarePolicy, collectSoftware } from "./collect";

/** Build a policy from the built-in default plus the one thing a test is about. */
function policy(patch: Partial<AgentPolicy>): AgentPolicy {
  return { ...AGENT_POLICY_DEFAULT, ...patch };
}

/** Collect the notes a filter files, so a test can assert the DEGRADATION is visible, not silent. */
function sink(): { warn: (m: string) => void; notes: string[] } {
  const notes: string[] = [];
  return { warn: (m) => notes.push(m), notes };
}

describe("applyNicPolicy (#1140)", () => {
  const nics = [
    { name: "eth0", mac: "aa:bb:cc:dd:ee:01" },
    { name: "veth1a2b", mac: "aa:bb:cc:dd:ee:02", isVirtual: true },
    { name: "docker0", mac: "aa:bb:cc:dd:ee:03", isVirtual: true },
  ];

  test("the built-in default changes nothing — an unconfigured estate behaves as it always did", () => {
    const { warn } = sink();
    expect(applyNicPolicy(nics, AGENT_POLICY_DEFAULT, warn)).toEqual(nics);
  });

  test("collect.nics=false omits the whole fact and SAYS SO in the report's warnings", () => {
    const { warn, notes } = sink();
    expect(applyNicPolicy(nics, policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, nics: false } }), warn)).toBeUndefined();
    // An empty column that looks identical whether the host has no NICs or the policy turned the
    // collector off is exactly the diagnostic gap #1138's warnings sink exists to close.
    expect(notes.join(" ")).toContain("policy");
  });

  test("exclusion globs drop matching interfaces and keep the rest", () => {
    const { warn } = sink();
    const filtered = applyNicPolicy(
      nics,
      policy({
        exclude: { ...AGENT_POLICY_DEFAULT.exclude, nicNames: ["veth*", "docker*"] },
      }),
      warn,
    );
    expect(filtered?.map((n) => n.name)).toEqual(["eth0"]);
  });

  test("excluding EVERY interface reports an empty list, not a missing one", () => {
    // Absent and empty are different answers everywhere else in this contract; a policy that
    // excludes everything is a positive finding ("nothing to report"), not a collector that failed.
    const { warn } = sink();
    expect(
      applyNicPolicy(nics, policy({ exclude: { ...AGENT_POLICY_DEFAULT.exclude, nicNames: ["*"] } }), warn),
    ).toEqual([]);
  });

  test("an absent NIC list stays absent — a filter never invents a fact", () => {
    const { warn } = sink();
    expect(applyNicPolicy(undefined, AGENT_POLICY_DEFAULT, warn)).toBeUndefined();
  });
});

describe("applyDiskPolicy (#1140)", () => {
  const disks = [
    { device: "sda1", mountpoint: "/" },
    { device: "overlay", mountpoint: "/var/lib/docker/overlay2/abc" },
    { device: "loop0", mountpoint: "/snap/core/1234" },
  ];

  test("mountpoint globs drop overlay noise", () => {
    const { warn } = sink();
    const filtered = applyDiskPolicy(
      disks,
      policy({
        exclude: {
          ...AGENT_POLICY_DEFAULT.exclude,
          mountpoints: ["/var/lib/docker/*", "/snap/*"],
        },
      }),
      warn,
    );
    expect(filtered?.map((d) => d.device)).toEqual(["sda1"]);
  });

  test("a disk with NO mountpoint is never excluded by a mountpoint glob", () => {
    // An unmounted disk is still a disk. Matching an absent value against a glob would silently
    // drop exactly the rows an operator most wants to see (a spare, an unmounted array member).
    const { warn } = sink();
    expect(
      applyDiskPolicy([{ device: "sdb" }], policy({
        exclude: { ...AGENT_POLICY_DEFAULT.exclude, mountpoints: ["*"] },
      }), warn)?.map((d) => d.device),
    ).toEqual(["sdb"]);
  });

  test("collect.disks=false omits the fact and warns", () => {
    const { warn, notes } = sink();
    expect(
      applyDiskPolicy(disks, policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, disks: false } }), warn),
    ).toBeUndefined();
    expect(notes).toHaveLength(1);
  });
});

describe("applySoftwarePolicy (#1140)", () => {
  const software = [
    { name: "nginx", version: "1.27.0", source: "dpkg" as const },
    { name: "linux-image-6.8.0-31", version: "6.8.0", source: "dpkg" as const },
    { name: "redis", version: "7.2", source: "apk" as const },
    { name: "unsourced" },
  ];

  test("the built-in default keeps everything", () => {
    const { warn } = sink();
    expect(applySoftwarePolicy(software, AGENT_POLICY_DEFAULT, warn)).toEqual(software);
  });

  test("name globs drop kernel churn", () => {
    const { warn } = sink();
    const kept = applySoftwarePolicy(
      software,
      policy({
        exclude: { ...AGENT_POLICY_DEFAULT.exclude, softwareNames: ["linux-image-*"] },
      }),
      warn,
    );
    expect(kept?.map((s) => s.name)).toEqual(["nginx", "redis", "unsourced"]);
  });

  test("an EMPTY softwareSources list means 'every source', not 'no sources'", () => {
    const { warn } = sink();
    expect(applySoftwarePolicy(software, policy({ softwareSources: [] }), warn)).toHaveLength(4);
  });

  test("a non-empty softwareSources list keeps only those, and drops entries with no source", () => {
    // A package the collector could not attribute cannot be shown to satisfy a source filter, and
    // guessing that it does would quietly re-admit exactly what the operator filtered out.
    const { warn } = sink();
    const kept = applySoftwarePolicy(software, policy({ softwareSources: ["dpkg"] }), warn);
    expect(kept?.map((s) => s.name)).toEqual(["nginx", "linux-image-6.8.0-31"]);
  });

  test("softwareMax truncates AFTER filtering, so the cap is spent on packages that survived", () => {
    const { warn, notes } = sink();
    const kept = applySoftwarePolicy(
      software,
      policy({
        softwareMax: 1,
        exclude: { ...AGENT_POLICY_DEFAULT.exclude, softwareNames: ["nginx"] },
      }),
      warn,
    );
    expect(kept?.map((s) => s.name)).toEqual(["linux-image-6.8.0-31"]);
    // Truncation is a degradation an operator should be able to see on the node, not a silent cut.
    expect(notes.join(" ")).toContain("truncated");
  });

  test("collect.software=false is decided by collectSoftware, which reports it as DISABLED and warns", async () => {
    // The toggle no longer lives here (#1142). `applySoftwarePolicy` filters a list it was given; only
    // `collectSoftware` knows whether the collector was turned off, ran and found nothing, or could
    // not run at all — and the server treats the first of those as "clear the stored list" and the
    // third as "keep it", so the outcome has to be decided where the three are still distinguishable.
    // Nothing is spawned on this path, so it is safe to exercise on any machine.
    const { warn, notes } = sink();
    const collected = await collectSoftware(
      warn,
      policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, software: false } }),
    );
    expect(collected).toEqual({ state: "disabled" });
    expect(notes).toHaveLength(1);
  });

  test("a policy that filters everything away yields an EMPTY list, not an absent one", () => {
    // `[]` is a positive finding — the collector ran and the policy matched every package — and the
    // server stores it as "no packages". Folding it to absent would make it indistinguishable from
    // "we could not look", which since #1142 means the opposite thing (keep the stored list).
    const { warn } = sink();
    expect(
      applySoftwarePolicy(software, policy({
        exclude: { ...AGENT_POLICY_DEFAULT.exclude, softwareNames: ["*"] },
      }), warn),
    ).toEqual([]);
  });
});
