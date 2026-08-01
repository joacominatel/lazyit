import { describe, expect, test } from "bun:test";
import {
  buildDiagnostics,
  buildIdentifiers,
  chassisFor,
  COLLECT_TIMEOUT_MS,
  collectOs,
  mapVirtualizationType,
  parseBootedAt,
  parseNics,
  parseTabbed,
  run,
} from "./collect";

/**
 * Issue #1133. Collection was unbounded: `run()` awaited Bun Shell, which offers no timeout, and
 * `collectHost` fires every collector concurrently. On a host where `lsblk` blocks on a degraded
 * NFS mount — or `dmidecode` blocks on a bad BMC — the whole report hung, the systemd unit stayed
 * in `activating` forever, and because `OnUnitActiveSec` only re-arms once a unit goes inactive,
 * THE TIMER NEVER FIRED AGAIN. The host then went dark and the staleness sweeper reported the
 * HOST as offline, when it was the agent that was wedged: the CMDB reported a false outage.
 *
 * These tests pin the contract `run()` owes the rest of the collector: a bounded wait, and `null`
 * for every failure mode so the best-effort design keeps degrading gracefully instead of throwing.
 */
describe("run", () => {
  test("returns stdout on success", async () => {
    expect(await run(["echo", "hello"])).toBe("hello\n");
  });

  test("returns null when the binary is missing", async () => {
    // The degradation path that matters most: a distro without lsblk/dmidecode/ip must still report.
    expect(await run(["lazyit-no-such-binary-exists"])).toBeNull();
  });

  test("returns null on a non-zero exit", async () => {
    expect(await run(["false"])).toBeNull();
  });

  test("kills a hung command at the timeout and returns null", async () => {
    const startedAt = Date.now();
    const out = await run(["sleep", "30"], 150);
    const elapsed = Date.now() - startedAt;

    expect(out).toBeNull();
    // The point of the issue: it must come back, and it must come back near the budget — not after
    // the 30s sleep, and not never. A generous ceiling keeps this green on a loaded CI runner.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("the default timeout is bounded and shorter than systemd's RuntimeMaxSec", () => {
    // install.sh caps the unit at RuntimeMaxSec=120. Every collector must be able to time out and
    // still let the agent finish a partial report BEFORE systemd kills the process outright —
    // otherwise a degraded host reports nothing instead of reporting what it could gather.
    expect(COLLECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(COLLECT_TIMEOUT_MS).toBeLessThan(120_000);
  });
});

/**
 * Contract v2 (#1138). `run()` degrades every failure to `null`, which is right for the REPORT and
 * wrong for the OPERATOR: an empty serial/model column looks identical whether the host has no
 * dmidecode, the agent lacks root, or a collector hung. `diagnostics.warnings` is what lets a fleet
 * view say "web-03: reporting unprivileged, no serial/model" instead of leaving that unanswerable.
 */
describe("run — diagnostics warnings (#1138)", () => {
  test("warns when the binary is missing, and still returns null", async () => {
    const warnings: string[] = [];
    expect(
      await run(["lazyit-no-such-binary-exists"], COLLECT_TIMEOUT_MS, (w) => warnings.push(w)),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("lazyit-no-such-binary-exists");
  });

  test("warns when a command times out (the #1133 path, now visible)", async () => {
    const warnings: string[] = [];
    expect(await run(["sleep", "30"], 150, (w) => warnings.push(w))).toBeNull();
    expect(warnings.join(" ")).toContain("timed out");
  });

  test("does NOT warn on a plain non-zero exit — that is an ANSWER, not a degraded collector", async () => {
    // `systemd-detect-virt` exits 1 to say "bare metal". Warning on that would put a line in every
    // physical host's report and train the operator to ignore the field.
    const warnings: string[] = [];
    expect(await run(["false"], COLLECT_TIMEOUT_MS, (w) => warnings.push(w))).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("buildDiagnostics — bounded, and always present (#1138)", () => {
  test("reports privilege + duration even when nothing went wrong", () => {
    // "This host reports unprivileged" is a FACT the operator needs whether or not anything failed —
    // it is the answer to "why is the serial column empty on web-03?".
    expect(buildDiagnostics([], false, 812)).toEqual({
      privileged: false,
      durationMs: 812,
    });
  });

  test("caps the warning list and truncates each message to what the contract accepts", () => {
    // The agent validates its own report before POSTing, so an over-long warning would turn a
    // DIAGNOSTIC into a hard failure to report at all — exactly backwards.
    const diagnostics = buildDiagnostics(
      Array.from({ length: 200 }, (_, i) => `w${i}`.padEnd(500, "x")),
      true,
      10,
    );
    expect(diagnostics.warnings).toHaveLength(50);
    for (const w of diagnostics.warnings ?? []) expect(w.length).toBeLessThanOrEqual(300);
  });
});

describe("collectOs — the platform discriminator (#1138)", () => {
  test("stamps family=linux and reads BUILD_ID as os.build", () => {
    const os = collectOs(
      'NAME="Ubuntu"\nVERSION_ID="24.04"\nBUILD_ID="2026-07-01"\n',
      "6.8.0-41-generic\n",
    );
    expect(os).toEqual({
      family: "linux",
      name: "Ubuntu",
      version: "24.04",
      kernel: "6.8.0-41-generic",
      build: "2026-07-01",
    });
  });

  test("still stamps the family when /etc/os-release is unreadable (the partial report)", () => {
    // `family` is the one v2 field that must never be missing — everything downstream branches on it.
    expect(collectOs(null, null)).toEqual({ family: "linux" });
  });
});

describe("mapVirtualizationType — systemd-detect-virt is an OPEN vocabulary (#1138)", () => {
  test("maps the values the contract enumerates", () => {
    expect(mapVirtualizationType("kvm")).toBe("kvm");
    expect(mapVirtualizationType("vmware")).toBe("vmware");
    expect(mapVirtualizationType("xen")).toBe("xen");
    expect(mapVirtualizationType("docker")).toBe("docker");
    expect(mapVirtualizationType("lxc")).toBe("lxc");
    expect(mapVirtualizationType("wsl")).toBe("wsl");
    expect(mapVirtualizationType("none")).toBe("none");
  });

  test("translates detect-virt's own names onto the contract's", () => {
    expect(mapVirtualizationType("microsoft")).toBe("hyperv");
    expect(mapVirtualizationType("qemu")).toBe("kvm");
    expect(mapVirtualizationType("podman")).toBe("docker");
    expect(mapVirtualizationType("lxc-libvirt")).toBe("lxc");
  });

  test("anything else is `other` — a hypervisor we never enumerated must not cost the host", () => {
    expect(mapVirtualizationType("oracle")).toBe("other");
    expect(mapVirtualizationType("bhyve")).toBe("other");
    expect(mapVirtualizationType("")).toBe("other");
  });
});

describe("chassisFor — what the host IS (#1138/#1139)", () => {
  test("virtualization WINS over the SMBIOS chassis type", () => {
    // A VM inherits its host board's chassis code, so DMI would call a KVM guest a "desktop".
    expect(chassisFor("kvm", "3")).toBe("vm");
    expect(chassisFor("docker", "17")).toBe("container");
    expect(chassisFor("lxc", null)).toBe("container");
    expect(chassisFor("wsl", null)).toBe("container");
  });

  test("bare metal reads the SMBIOS chassis type", () => {
    expect(chassisFor("none", "17")).toBe("server"); // main server chassis
    expect(chassisFor("none", "23")).toBe("server"); // rack mount
    expect(chassisFor("none", "9")).toBe("laptop");
    expect(chassisFor("none", "31")).toBe("laptop"); // convertible
    expect(chassisFor("none", "3")).toBe("desktop");
  });

  test("an unknown/absent chassis code is `unknown`, never a guess", () => {
    expect(chassisFor("none", "2")).toBe("unknown");
    expect(chassisFor("none", null)).toBe("unknown");
    expect(chassisFor("none", "not-a-number")).toBe("unknown");
  });
});

describe("parseNics — IPv6 + virtual-interface flag (#1138)", () => {
  const IP_JSON = JSON.stringify([
    { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1" }] },
    {
      ifname: "eth0",
      address: "aa:bb:cc:dd:ee:ff",
      addr_info: [
        { family: "inet", local: "10.0.0.12" },
        { family: "inet6", local: "2001:db8::12" },
        { family: "inet6", local: "fe80::1" },
      ],
    },
    { ifname: "docker0", address: "02:42:ac:11:00:02", addr_info: [] },
  ]);

  test("splits v4 and v6, keeping link-local (the promotion mapper decides, not the collector)", () => {
    const nics = parseNics(IP_JSON);
    expect(nics?.[0]).toEqual({
      name: "eth0",
      mac: "aa:bb:cc:dd:ee:ff",
      ipv4: ["10.0.0.12"],
      ipv6: ["2001:db8::12", "fe80::1"],
    });
  });

  test("drops loopback and returns undefined when `ip -j addr` gave nothing usable", () => {
    expect(parseNics(IP_JSON)?.map((n) => n.name)).toEqual(["eth0", "docker0"]);
    expect(parseNics(null)).toBeUndefined();
    expect(parseNics("not json")).toBeUndefined();
    expect(parseNics("[]")).toBeUndefined();
  });
});

describe("parseBootedAt — one scalar, never a metric (#1138)", () => {
  test("reads /proc/stat's btime (an absolute instant, so it never drifts)", () => {
    expect(parseBootedAt("cpu  1 2 3\nbtime 1767225600\nprocesses 42\n")).toBe(
      new Date(1767225600 * 1000).toISOString(),
    );
  });

  test("returns undefined when btime is absent or garbage (omit, never fabricate)", () => {
    expect(parseBootedAt("cpu 1 2 3\n")).toBeUndefined();
    expect(parseBootedAt("btime notanumber\n")).toBeUndefined();
    expect(parseBootedAt(null)).toBeUndefined();
  });
});

describe("parseTabbed — package-manager provenance (#1138)", () => {
  test("stamps the source that produced the list", () => {
    expect(parseTabbed("nginx\t1.27.0\nopenssl\t3.0.13\n", "dpkg")).toEqual([
      { name: "nginx", version: "1.27.0", source: "dpkg" },
      { name: "openssl", version: "3.0.13", source: "dpkg" },
    ]);
  });
});

describe("buildIdentifiers — the corroborating set #1141 consumes (#1138)", () => {
  test("collects each identity fact it actually has, kinded", () => {
    expect(
      buildIdentifiers({
        machineId: "9f8d7c6b5a4e3f2a",
        smbiosUuid: "4C4C4544-0043",
        serial: "ABC123",
        mac: "aa:bb:cc:dd:ee:ff",
      }),
    ).toEqual([
      { kind: "machine-id", value: "9f8d7c6b5a4e3f2a" },
      { kind: "smbios-uuid", value: "4C4C4544-0043" },
      { kind: "serial", value: "ABC123" },
      { kind: "mac", value: "aa:bb:cc:dd:ee:ff" },
    ]);
  });

  test("omits the ones it lacks — and the whole key when it has none", () => {
    expect(buildIdentifiers({ machineId: "abc" })).toEqual([
      { kind: "machine-id", value: "abc" },
    ]);
    expect(buildIdentifiers({})).toBeUndefined();
    expect(buildIdentifiers({ machineId: "  ", serial: "" })).toBeUndefined();
  });
});
