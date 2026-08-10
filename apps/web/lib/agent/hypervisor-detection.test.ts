/**
 * The wizard's step-3 detection feedback (#1225) — pure derivations over data the wait step already
 * holds, asserted here because both are read-tolerant claims about OTHER code's shapes:
 *
 *  - `hypervisorFacetOf` reads the ADR-0095 facet off a node detail's `specs` blob, which is jsonb
 *    the wire types as `unknown` — so every malformed shape must degrade to null, never throw in
 *    the middle of the wizard's celebration screen.
 *  - `countPendingGuests` re-derives ADR-0095 §5's child key rule through the SHARED helpers
 *    (`guestExternalIdPrefix`), so a future change to the separator cannot silently zero the count.
 */
import { describe, expect, test } from "bun:test";
import { guestExternalId } from "@lazyit/shared";
import {
  countPendingGuests,
  hypervisorFacetOf,
  hypervisorPlatformLabel,
} from "./hypervisor-detection";

const HOST_ID = "machine:9a1b2c3d4e5f60718293a4b5c6d7e8f9";

describe("hypervisorFacetOf", () => {
  test("reads the ADR-0095 facet off specs.host.hypervisor, platform + version", () => {
    const specs = {
      host: {
        hostname: "pve-01",
        hypervisor: { platform: "proxmox", version: "8.4.1", nodeName: "pve-01" },
      },
      reportedAt: "2026-08-06T12:00:00Z",
    };
    expect(hypervisorFacetOf(specs)).toEqual({ platform: "proxmox", version: "8.4.1" });
  });

  test("version is optional — the facet stands on platform alone", () => {
    expect(
      hypervisorFacetOf({ host: { hypervisor: { platform: "hyperv" } } }),
    ).toEqual({ platform: "hyperv" });
  });

  test("null when the host is simply not a hypervisor (facet absent)", () => {
    expect(hypervisorFacetOf({ host: { hostname: "web-01" } })).toBeNull();
  });

  test("degrades to null on a malformed blob, never throws", () => {
    // `specs` is jsonb typed `unknown` on the wire; a legacy or hand-edited blob of any shape must
    // cost the callout, never crash the wizard's success screen.
    const malformed: unknown[] = [
      null,
      undefined,
      "a string",
      42,
      [],
      { host: null },
      { host: "x" },
      { host: { hypervisor: "proxmox" } },
      { host: { hypervisor: { version: "8" } } },
      { host: { hypervisor: { platform: 7 } } },
    ];
    for (const specs of malformed) {
      expect(hypervisorFacetOf(specs)).toBeNull();
    }
  });

  test("drops a non-string version rather than the whole facet", () => {
    expect(
      hypervisorFacetOf({ host: { hypervisor: { platform: "libvirt", version: 8 } } }),
    ).toEqual({ platform: "libvirt" });
  });
});

describe("hypervisorPlatformLabel", () => {
  test.each([
    ["proxmox", "Proxmox VE"],
    ["hyperv", "Hyper-V"],
    ["libvirt", "libvirt/KVM"],
    ["xcpng", "XCP-ng"],
  ] as const)("names %s the way the installers' banners do: %s", (platform, label) => {
    // The vocabulary is AgentHypervisorPlatformSchema's; the display names are the ones the
    // installers print ("Detected: Proxmox VE …") and the Manual uses — one spelling everywhere.
    expect(hypervisorPlatformLabel(platform)).toBe(label);
  });

  test.each(["other", "vmware", ""])(
    "null for %p — the caller falls back to its generic copy instead of printing a raw enum member",
    (platform) => {
      expect(hypervisorPlatformLabel(platform)).toBeNull();
    },
  );
});

describe("countPendingGuests", () => {
  const guest = (ref: string) => ({ externalId: guestExternalId(HOST_ID, ref) });

  test("counts exactly this host's guest children out of the pending list", () => {
    const pending = [
      { externalId: HOST_ID }, // the host itself — never its own guest
      guest("101"),
      guest("102"),
      { externalId: guestExternalId("machine:ffff", "101") }, // another host's vmid 101
      { externalId: `${HOST_ID}/container/redis` }, // a Docker child, not a guest (#1139)
      { externalId: null }, // a hand-created proposal with no reporting key
    ];
    expect(countPendingGuests(HOST_ID, pending)).toBe(2);
  });

  test("0 for an empty list, and for a host with no guests pending", () => {
    expect(countPendingGuests(HOST_ID, [])).toBe(0);
    expect(countPendingGuests(HOST_ID, [{ externalId: HOST_ID }])).toBe(0);
  });

  test("0 when the host has no externalId — a prefix built from nothing must match nothing", () => {
    // `guestExternalIdPrefix("")` is "/guest/", which every guest key CONTAINS — an unguarded call
    // would count every guest of every host as this one's.
    const pending = [guest("101"), guest("102")];
    expect(countPendingGuests(null, pending)).toBe(0);
    expect(countPendingGuests(undefined, pending)).toBe(0);
    expect(countPendingGuests("", pending)).toBe(0);
  });
});
