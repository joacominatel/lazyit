import { describe, expect, it } from "bun:test";
import {
  INFRA_POLICY_SENSITIVE_FACTS,
  diffContainerFacts,
  diffHostFacts,
  diffSoftwareFacts,
} from "./infra-fact-change";

/**
 * The two observations were collected under the SAME agent policy generation — the ordinary case,
 * and the only one in which a difference can be attributed to the host.
 */
const SAME = { samePolicyGeneration: true };
/** The policy MOVED between the two observations, so a filtered fact may have moved with it. */
const POLICY_MOVED = { samePolicyGeneration: false };

describe("diffHostFacts", () => {
  it("emits nothing when there is no stored host block — the first observation SEEDS the baseline", () => {
    expect(
      diffHostFacts(
        undefined,
        {
          hostname: "db-01",
          memoryBytes: 34359738368,
          os: { family: "linux", version: "24.04", kernel: "6.8.0-31-generic" },
        },
        SAME,
      ),
    ).toEqual([]);
  });

  it("emits nothing for a fact observed for the FIRST time on an existing node", () => {
    // The node was enrolled by an unprivileged agent (no dmidecode); root arrives later and the
    // serial appears. That is a first observation, not a change.
    expect(
      diffHostFacts(
        { hostname: "db-01" },
        { hostname: "db-01", hardware: { serial: "S1" } },
        SAME,
      ),
    ).toEqual([]);
  });

  it("emits nothing when a fact DISAPPEARS — a collector that lost root did not change the host", () => {
    expect(
      diffHostFacts({ hardware: { serial: "S1" } }, { hostname: "db-01" }, SAME),
    ).toEqual([]);
  });

  it("records an OS version and kernel move", () => {
    const changes = diffHostFacts(
      { os: { version: "22.04", kernel: "5.15.0-91-generic" } },
      { os: { version: "24.04", kernel: "6.8.0-31-generic" } },
      SAME,
    );
    expect(changes).toEqual([
      {
        kind: "FACT_CHANGED",
        fact: "host.os.version",
        previousValue: "22.04",
        currentValue: "24.04",
      },
      {
        kind: "FACT_CHANGED",
        fact: "host.os.kernel",
        previousValue: "5.15.0-91-generic",
        currentValue: "6.8.0-31-generic",
      },
    ]);
  });

  it("records memory, serial and OS name moves", () => {
    const changes = diffHostFacts(
      {
        memoryBytes: 17179869184,
        hardware: { serial: "OLD-SERIAL" },
        os: { name: "Ubuntu 22.04.4 LTS" },
      },
      {
        memoryBytes: 34359738368,
        hardware: { serial: "NEW-SERIAL" },
        os: { name: "Ubuntu 24.04.1 LTS" },
      },
      SAME,
    );
    expect(changes.map((c) => c.fact)).toEqual([
      "host.os.name",
      "host.memoryBytes",
      "host.hardware.serial",
    ]);
    expect(changes.every((c) => c.kind === "FACT_CHANGED")).toBe(true);
  });

  it("records a disk capacity change as total bytes plus the device count", () => {
    const changes = diffHostFacts(
      { disks: [{ device: "sda", sizeBytes: 500 }] },
      {
        disks: [
          { device: "sda", sizeBytes: 500 },
          { device: "sdb", sizeBytes: 1000 },
        ],
      },
      SAME,
    );
    expect(changes).toEqual([
      {
        kind: "FACT_CHANGED",
        fact: "host.disks.totalBytes",
        previousValue: "500",
        currentValue: "1500",
      },
      {
        kind: "FACT_CHANGED",
        fact: "host.disks.count",
        previousValue: "1",
        currentValue: "2",
      },
    ]);
  });

  it("a disks list the AGENT POLICY emptied is no evidence, not every disk disappearing", () => {
    // `applyDiskPolicy` (#1140) returns `[]` — not `undefined` — when the operator's mountpoint
    // globs exclude every mounted filesystem, because "the policy matched them all" is a positive
    // answer to the collector. It is NOT a positive answer about the hardware, and the operator who
    // just edited a policy must never read `host.disks.count 2 → 0` off the Changes tab: that is a
    // hardware event the table would have invented out of a configuration change.
    //
    // `host.disks.totalBytes` already refuses to answer `0` here. The count now refuses too.
    expect(
      diffHostFacts(
        { disks: [{ device: "sda", sizeBytes: 500 }, { device: "sdb", sizeBytes: 1000 }] },
        { disks: [] },
        SAME,
      ),
    ).toEqual([]);
    // The same silence in reverse: an empty stored list is no baseline to diff against either.
    expect(diffHostFacts({ disks: [] }, { disks: [{ device: "sda" }] }, SAME)).toEqual([]);
    // And an array carrying no readable disk record at all says nothing — same rule as the sibling.
    expect(
      diffHostFacts({ disks: [{ device: "sda" }] }, { disks: ["nonsense", 7] }, SAME),
    ).toEqual([]);
  });

  it("emits nothing when nothing tracked moved, however much else did", () => {
    expect(
      diffHostFacts(
        { hostname: "db-01", memoryBytes: 8, nics: [{ name: "eth0" }] },
        { hostname: "db-02", memoryBytes: 8, nics: [{ name: "eth1" }], bootedAt: "x" },
        SAME,
      ),
    ).toEqual([]);
  });

  it("never throws on a hand-edited blob of the wrong shape", () => {
    expect(diffHostFacts("nonsense", 42, SAME)).toEqual([]);
    expect(diffHostFacts({ os: "nonsense" }, { os: { version: "24.04" } }, SAME)).toEqual([]);
    expect(
      diffHostFacts({ disks: "nonsense" }, { disks: [{ device: "sda" }] }, SAME),
    ).toEqual([]);
  });
});

describe("diffSoftwareFacts", () => {
  it("emits nothing when the node held no list — the first list SEEDS the baseline", () => {
    expect(
      diffSoftwareFacts(undefined, [{ name: "openssl", version: "3.0.2" }], 200, SAME),
    ).toEqual([]);
    expect(diffSoftwareFacts("nonsense", [{ name: "openssl" }], 200, SAME)).toEqual([]);
  });

  it("records an upgrade, an install and a removal, ordered by package name", () => {
    const changes = diffSoftwareFacts(
      [
        { name: "openssl", version: "3.0.2" },
        { name: "nginx", version: "1.24.0" },
      ],
      [
        { name: "openssl", version: "3.0.13" },
        { name: "curl", version: "8.5.0" },
      ],
      200,
      SAME,
    );
    expect(changes).toEqual([
      {
        kind: "PACKAGE_ADDED",
        fact: "curl",
        currentValue: "8.5.0",
      },
      {
        kind: "PACKAGE_REMOVED",
        fact: "nginx",
        previousValue: "1.24.0",
      },
      {
        kind: "PACKAGE_VERSION",
        fact: "openssl",
        previousValue: "3.0.2",
        currentValue: "3.0.13",
      },
    ]);
  });

  it("emits nothing when the same list arrives in a different order", () => {
    expect(
      diffSoftwareFacts(
        [{ name: "a", version: "1" }, { name: "b", version: "2" }],
        [{ name: "b", version: "2" }, { name: "a", version: "1" }],
        200,
        SAME,
      ),
    ).toEqual([]);
  });

  it("caps the result at the limit, deterministically", () => {
    const previous = Array.from({ length: 500 }, (_, i) => ({
      name: `pkg-${String(i).padStart(4, "0")}`,
      version: "1",
    }));
    const next = previous.map((p) => ({ ...p, version: "2" }));
    const changes = diffSoftwareFacts(previous, next, 200, SAME);
    expect(changes).toHaveLength(200);
    expect(changes[0]?.fact).toBe("pkg-0000");
    expect(changes[199]?.fact).toBe("pkg-0199");
  });

  it("treats a cleared list as no package news at all, never 3,000 removals", () => {
    expect(diffSoftwareFacts([{ name: "openssl" }], undefined, 200, SAME)).toEqual([]);
    expect(diffSoftwareFacts([{ name: "openssl" }], [], 200, SAME)).toEqual([]);
  });

  it("drops malformed entries rather than throwing", () => {
    expect(
      diffSoftwareFacts(
        [{ name: "openssl", version: "1" }, "junk", { version: "no name" }],
        [{ name: "openssl", version: "2" }, null],
        200,
        SAME,
      ),
    ).toEqual([
      {
        kind: "PACKAGE_VERSION",
        fact: "openssl",
        previousValue: "1",
        currentValue: "2",
      },
    ]);
  });

  it("records a version appearing or disappearing on a package that stayed installed", () => {
    expect(
      diffSoftwareFacts(
        [{ name: "openssl" }],
        [{ name: "openssl", version: "3.0.13" }],
        200,
        SAME,
      ),
    ).toEqual([
      {
        kind: "PACKAGE_VERSION",
        fact: "openssl",
        currentValue: "3.0.13",
      },
    ]);
  });
});

describe("diffContainerFacts", () => {
  it("emits nothing on the first observation", () => {
    expect(
      diffContainerFacts(undefined, { name: "api", image: "lazyit/api:1.2.0" }, SAME),
    ).toEqual([]);
  });

  it("records an image tag and digest move — the silent :latest re-pull", () => {
    expect(
      diffContainerFacts(
        { name: "api", image: "lazyit/api:latest", imageDigest: "sha256:aaa" },
        { name: "api", image: "lazyit/api:latest", imageDigest: "sha256:bbb" },
        SAME,
      ),
    ).toEqual([
      {
        kind: "FACT_CHANGED",
        fact: "container.imageDigest",
        previousValue: "sha256:aaa",
        currentValue: "sha256:bbb",
      },
    ]);
  });

  it("does NOT record the runtime state — that is liveness, not inventory", () => {
    expect(
      diffContainerFacts(
        { name: "api", state: "running" },
        { name: "api", state: "exited" },
        SAME,
      ),
    ).toEqual([]);
  });

  it("never throws on a hand-edited blob", () => {
    expect(diffContainerFacts("nonsense", 7, SAME)).toEqual([]);
  });
});

/**
 * The CLASS, not the instance (#1143 review). An agent policy (#1140) is a deliberate operator
 * action that changes WHAT THE COLLECTOR REPORTS without anything on the host moving. Every fact
 * whose value a policy can filter therefore needs the same guard the disk facts already carry, and
 * the guard has to be one rule rather than a special case per fact — otherwise the next fact added
 * to the diff arrives unguarded and the invented event comes back under a different name.
 */
describe("a policy move never masquerades as a host change", () => {
  it("names the policy-sensitive tracked facts, so a new one has to declare itself", () => {
    // The package half is policy-sensitive in its ENTIRETY (three policy fields filter it) and is
    // not a keyed fact, so it is guarded wholesale rather than listed here.
    expect(INFRA_POLICY_SENSITIVE_FACTS).toEqual([
      "host.disks.totalBytes",
      "host.disks.count",
    ]);
  });

  it("records no disk row when the two observations ran under different policy generations", () => {
    // The operator added `/snap/*` to `exclude.mountpoints`. The next report legitimately carries
    // one disk fewer and less total capacity. Nothing was unplugged.
    expect(
      diffHostFacts(
        {
          disks: [
            { device: "sda", sizeBytes: 500 },
            { device: "loop0", sizeBytes: 1000, mountpoint: "/snap/core" },
          ],
        },
        { disks: [{ device: "sda", sizeBytes: 500 }] },
        POLICY_MOVED,
      ),
    ).toEqual([]);
  });

  it("still records the facts NO policy can filter, even when the generation moved", () => {
    // The guard is per fact, not per report: a policy edit must not blind the timeline to the
    // kernel upgrade that landed in the same check-in.
    expect(
      diffHostFacts(
        { os: { kernel: "6.8.0-30-generic" }, memoryBytes: 8, hardware: { serial: "S1" } },
        { os: { kernel: "6.8.0-31-generic" }, memoryBytes: 16, hardware: { serial: "S2" } },
        POLICY_MOVED,
      ).map((c) => c.fact),
    ).toEqual(["host.os.kernel", "host.memoryBytes", "host.hardware.serial"]);
  });

  it("records NO package row when the generation moved — an exclusion glob is not an uninstall", () => {
    // `applySoftwarePolicy` (#1140) filters by `exclude.softwareNames`, by `softwareSources` and
    // then truncates to `softwareMax`. Each of the three makes packages leave the reported list
    // while they stay installed on the host, and each is an operator editing a policy.
    expect(
      diffSoftwareFacts(
        [
          { name: "linux-image-6.8.0-30", version: "1" },
          { name: "linux-image-6.8.0-31", version: "1" },
          { name: "openssl", version: "3.0.2" },
        ],
        [{ name: "openssl", version: "3.0.13" }],
        200,
        POLICY_MOVED,
      ),
    ).toEqual([]);
  });

  it("container facts are not policy-filtered, so they are recorded either way", () => {
    // `collect.containers` is all-or-nothing: turning it off omits the whole fact, which the
    // disappearance rule already silences. No policy field edits what a container REPORTS.
    expect(
      diffContainerFacts(
        { name: "api", imageDigest: "sha256:aaa" },
        { name: "api", imageDigest: "sha256:bbb" },
        POLICY_MOVED,
      ),
    ).toEqual([
      {
        kind: "FACT_CHANGED",
        fact: "container.imageDigest",
        previousValue: "sha256:aaa",
        currentValue: "sha256:bbb",
      },
    ]);
  });
});
