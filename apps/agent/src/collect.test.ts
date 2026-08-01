import { describe, expect, test } from "bun:test";
import { AGENT_CONTAINERS_MAX } from "@lazyit/shared";
import {
  buildDiagnostics,
  buildIdentifiers,
  chassisFor,
  COLLECT_TIMEOUT_MS,
  collectOs,
  mapVirtualizationType,
  parseBootedAt,
  parseDockerContainers,
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

  test("NO virtualization probe is `unknown` — it is not an assertion of bare metal", () => {
    // `systemd-detect-virt` absent (a non-systemd distro, a minimal container image) used to be read
    // as `none`, which then classified the host from DMI it does not own: inside a container `/sys`
    // shows the HOST's chassis, so the container confidently reported `server`. "Unknown" and "none"
    // are different facts and the contract has vocabulary for both.
    expect(chassisFor(undefined, "17")).toBe("unknown");
    expect(chassisFor(undefined, "3")).toBe("unknown");
    expect(chassisFor(undefined, null)).toBe("unknown");
  });
});

describe("parseNics — IPv6 with enough context to pick a STABLE address (#1138)", () => {
  const IP_JSON = JSON.stringify([
    { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1" }] },
    {
      ifname: "eth0",
      address: "aa:bb:cc:dd:ee:ff",
      addr_info: [
        { family: "inet", local: "10.0.0.12" },
        {
          family: "inet6",
          local: "2001:db8::dead",
          prefixlen: 64,
          scope: "global",
          temporary: true,
        },
        { family: "inet6", local: "2001:db8::12", prefixlen: 64, scope: "global" },
        { family: "inet6", local: "fe80::1", prefixlen: 64, scope: "link" },
      ],
    },
    { ifname: "docker0", address: "02:42:ac:11:00:02", addr_info: [] },
  ]);

  test("carries scope, prefix length and the RFC 4941 flags the promotion rule needs", () => {
    const nics = parseNics(IP_JSON);
    expect(nics?.[0]).toEqual({
      name: "eth0",
      mac: "aa:bb:cc:dd:ee:ff",
      ipv4: ["10.0.0.12"],
      ipv6: [
        {
          address: "2001:db8::dead",
          prefixLength: 64,
          scope: "global",
          temporary: true,
        },
        { address: "2001:db8::12", prefixLength: 64, scope: "global" },
        { address: "fe80::1", prefixLength: 64, scope: "link" },
      ],
    });
  });

  test("reads a spent preferred lifetime as deprecated (iproute2 does not always flag it)", () => {
    const nics = parseNics(
      JSON.stringify([
        {
          ifname: "eth0",
          addr_info: [
            {
              family: "inet6",
              local: "2001:db8::old",
              scope: "global",
              preferred_life_time: 0,
            },
          ],
        },
      ]),
    );
    expect(nics?.[0]?.ipv6?.[0]?.deprecated).toBe(true);
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

describe("parseDockerContainers — the child nodes the graph was missing (#1139)", () => {
  /** One element of `GET /containers/json`, in the runtime's own spelling. */
  const RUNNING = {
    Id: "3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a",
    Names: ["/lazyit-api"],
    Image: "ghcr.io/acme/api:1.4.0",
    ImageID: "sha256:9f8d7c6b5a4e3f2a1b0c9d8e7f6a5b4c",
    State: "running",
    Ports: [{ IP: "0.0.0.0", PrivatePort: 3001, PublicPort: 8081, Type: "tcp" }],
  };

  test("maps a container onto the contract, stripping the leading slash off its name", () => {
    expect(parseDockerContainers(JSON.stringify([RUNNING]))).toEqual([
      {
        name: "lazyit-api",
        id: "3f2a1b0c9d8e",
        image: "ghcr.io/acme/api:1.4.0",
        imageDigest: "sha256:9f8d7c6b5a4e3f2a1b0c9d8e7f6a5b4c",
        state: "running",
        ports: [{ containerPort: 3001, hostPort: 8081, hostIp: "0.0.0.0", protocol: "tcp" }],
      },
    ]);
  });

  test("an EMPTY runtime list stays `[]` — the positive `runs no containers` finding", () => {
    // Collapsing this to undefined would make "Docker is installed and empty" indistinguishable from
    // "no Docker here", and the server acts on exactly that difference (it retires child nodes).
    expect(parseDockerContainers("[]")).toEqual([]);
  });

  test("unreadable or non-JSON output omits the key entirely rather than asserting emptiness", () => {
    expect(parseDockerContainers(null)).toBeUndefined();
    expect(parseDockerContainers("<html>404</html>")).toBeUndefined();
    expect(parseDockerContainers('{"message":"permission denied"}')).toBeUndefined();
  });

  test("a nameless container is dropped, the rest of the list survives", () => {
    expect(
      parseDockerContainers(JSON.stringify([{ Names: [], State: "running" }, RUNNING])),
    ).toHaveLength(1);
  });

  test("an unmapped port (no host side) still records that the port is exposed", () => {
    expect(
      parseDockerContainers(
        JSON.stringify([{ ...RUNNING, Ports: [{ PrivatePort: 5432, Type: "tcp" }] }]),
      )?.[0]?.ports,
    ).toEqual([{ containerPort: 5432, protocol: "tcp" }]);
  });

  test("the container id ships truncated — it is evidence, and the KEY is the name", () => {
    // Keying on the id would mint a fresh PENDING proposal on every `docker compose up`; the short
    // form is what the operator sees in `docker ps` and all the corroboration this needs.
    const parsed = parseDockerContainers(JSON.stringify([RUNNING]));
    expect(parsed?.[0]?.id).toBe("3f2a1b0c9d8e");
  });

  test("the list is capped at what the contract accepts, never beyond", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...RUNNING, Names: [`/c${i}`] }));
    expect(parseDockerContainers(JSON.stringify(many))).toHaveLength(AGENT_CONTAINERS_MAX);
  });
});

describe("buildIdentifiers — the corroborating set #1141 consumes (#1138)", () => {
  test("collects each identity fact it actually has, kinded and in its CANONICAL form", () => {
    // The canonical form is the contract's (`normalizeIdentifierValue`), applied here too so the
    // agent's own log and the server's stored evidence read identically.
    expect(
      buildIdentifiers({
        machineId: "9F8D7C6B5A4E3F2A",
        smbiosUuid: "{4C4C4544-0043-0010-8036-B1C04F574D32}",
        serial: "  ABC   123  ",
        mac: "AA-BB-CC-DD-EE-FF",
      }),
    ).toEqual([
      { kind: "machine-id", value: "9f8d7c6b5a4e3f2a" },
      { kind: "smbios-uuid", value: "4c4c4544-0043-0010-8036-b1c04f574d32" },
      { kind: "serial", value: "ABC 123" },
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

  test("refuses the dmidecode junk placeholders instead of shipping them as evidence", () => {
    // These are the literal strings OEMs flash on whole production runs. #1141 corroborates hosts
    // by comparing identifier values, so two unrelated boxes both reporting `Default string` would
    // match as the SAME physical host. `sanitizeSerial` already refused them on `Asset.serial`;
    // the identifier path reuses that exact list rather than opening a second door for the junk.
    expect(
      buildIdentifiers({
        serial: "To be filled by O.E.M.",
        smbiosUuid: "03000200-0400-0500-0006-000700080009",
        mac: "00:00:00:00:00:00",
        machineId: "00000000000000000000000000000000",
      }),
    ).toBeUndefined();
  });

  test("keeps the real facts when only SOME of them are junk", () => {
    expect(
      buildIdentifiers({ machineId: "9F8D7C6B5A4E", serial: "Default string" }),
    ).toEqual([{ kind: "machine-id", value: "9f8d7c6b5a4e" }]);
  });
});
