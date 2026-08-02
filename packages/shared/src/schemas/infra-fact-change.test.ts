import { describe, expect, it } from "bun:test";
import {
  diffContainerFacts,
  diffHostFacts,
  diffSoftwareFacts,
} from "./infra-fact-change";

describe("diffHostFacts", () => {
  it("emits nothing when there is no stored host block — the first observation SEEDS the baseline", () => {
    expect(
      diffHostFacts(undefined, {
        hostname: "db-01",
        memoryBytes: 34359738368,
        os: { family: "linux", version: "24.04", kernel: "6.8.0-31-generic" },
      }),
    ).toEqual([]);
  });

  it("emits nothing for a fact observed for the FIRST time on an existing node", () => {
    // The node was enrolled by an unprivileged agent (no dmidecode); root arrives later and the
    // serial appears. That is a first observation, not a change.
    expect(
      diffHostFacts({ hostname: "db-01" }, { hostname: "db-01", hardware: { serial: "S1" } }),
    ).toEqual([]);
  });

  it("emits nothing when a fact DISAPPEARS — a collector that lost root did not change the host", () => {
    expect(
      diffHostFacts({ hardware: { serial: "S1" } }, { hostname: "db-01" }),
    ).toEqual([]);
  });

  it("records an OS version and kernel move", () => {
    const changes = diffHostFacts(
      { os: { version: "22.04", kernel: "5.15.0-91-generic" } },
      { os: { version: "24.04", kernel: "6.8.0-31-generic" } },
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

  it("emits nothing when nothing tracked moved, however much else did", () => {
    expect(
      diffHostFacts(
        { hostname: "db-01", memoryBytes: 8, nics: [{ name: "eth0" }] },
        { hostname: "db-02", memoryBytes: 8, nics: [{ name: "eth1" }], bootedAt: "x" },
      ),
    ).toEqual([]);
  });

  it("never throws on a hand-edited blob of the wrong shape", () => {
    expect(diffHostFacts("nonsense", 42)).toEqual([]);
    expect(diffHostFacts({ os: "nonsense" }, { os: { version: "24.04" } })).toEqual([]);
    expect(diffHostFacts({ disks: "nonsense" }, { disks: [{ device: "sda" }] })).toEqual([]);
  });
});

describe("diffSoftwareFacts", () => {
  it("emits nothing when the node held no list — the first list SEEDS the baseline", () => {
    expect(
      diffSoftwareFacts(undefined, [{ name: "openssl", version: "3.0.2" }], 200),
    ).toEqual([]);
    expect(diffSoftwareFacts("nonsense", [{ name: "openssl" }], 200)).toEqual([]);
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
      ),
    ).toEqual([]);
  });

  it("caps the result at the limit, deterministically", () => {
    const previous = Array.from({ length: 500 }, (_, i) => ({
      name: `pkg-${String(i).padStart(4, "0")}`,
      version: "1",
    }));
    const next = previous.map((p) => ({ ...p, version: "2" }));
    const changes = diffSoftwareFacts(previous, next, 200);
    expect(changes).toHaveLength(200);
    expect(changes[0]?.fact).toBe("pkg-0000");
    expect(changes[199]?.fact).toBe("pkg-0199");
  });

  it("treats a cleared list as no package news at all, never 3,000 removals", () => {
    expect(diffSoftwareFacts([{ name: "openssl" }], undefined, 200)).toEqual([]);
    expect(diffSoftwareFacts([{ name: "openssl" }], [], 200)).toEqual([]);
  });

  it("drops malformed entries rather than throwing", () => {
    expect(
      diffSoftwareFacts(
        [{ name: "openssl", version: "1" }, "junk", { version: "no name" }],
        [{ name: "openssl", version: "2" }, null],
        200,
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
      diffSoftwareFacts([{ name: "openssl" }], [{ name: "openssl", version: "3.0.13" }], 200),
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
      diffContainerFacts(undefined, { name: "api", image: "lazyit/api:1.2.0" }),
    ).toEqual([]);
  });

  it("records an image tag and digest move — the silent :latest re-pull", () => {
    expect(
      diffContainerFacts(
        { name: "api", image: "lazyit/api:latest", imageDigest: "sha256:aaa" },
        { name: "api", image: "lazyit/api:latest", imageDigest: "sha256:bbb" },
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
      ),
    ).toEqual([]);
  });

  it("never throws on a hand-edited blob", () => {
    expect(diffContainerFacts("nonsense", 7)).toEqual([]);
  });
});
