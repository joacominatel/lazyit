import { describe, expect, test } from "bun:test";
import { softwareFingerprint } from "@lazyit/shared";
import { softwareWireFields, type SoftwareCollection } from "./software-delta";

const PKGS = [
  { name: "nginx", version: "1.27.0", source: "dpkg" as const },
  { name: "redis", version: "7.2", source: "dpkg" as const },
];
const HASH = softwareFingerprint(PKGS);

const reported: SoftwareCollection = { state: "reported", software: PKGS };

describe("softwareWireFields — the client half of the delta (#1142)", () => {
  test("a first run has no cached fingerprint, so it sends the whole list", () => {
    const { fields, cache } = softwareWireFields(reported, undefined);
    expect(fields.software).toEqual(PKGS);
    expect(fields.softwareState).toBe("reported");
    expect(fields.softwareHash).toBe(HASH);
    expect(cache).toBe(HASH);
  });

  test("an UNCHANGED list is omitted but still fingerprinted — the ~90% steady-state saving", () => {
    const { fields, cache } = softwareWireFields(reported, HASH);
    expect(fields.software).toBeUndefined();
    expect(fields.softwareState).toBe("unchanged");
    // The fingerprint always rides along: without it the server has nothing to corroborate the claim
    // against, and "unchanged" would be a client assertion the server had to take on faith.
    expect(fields.softwareHash).toBe(HASH);
    expect(cache).toBe(HASH);
  });

  test("a CHANGED list is sent in full again", () => {
    const { fields, cache } = softwareWireFields(reported, "1-2-staleeeeeeeeeeeeeeeeeeeeeeee");
    expect(fields.software).toEqual(PKGS);
    expect(fields.softwareState).toBe("reported");
    expect(cache).toBe(HASH);
  });

  test("an EMPTY list is REPORTED, not omitted — 'the policy filtered everything' is a finding", () => {
    const { fields } = softwareWireFields({ state: "reported", software: [] }, undefined);
    expect(fields.software).toEqual([]);
    expect(fields.softwareState).toBe("reported");
  });

  test("UNAVAILABLE sends no list and no fingerprint, and KEEPS the cached one", () => {
    // The server preserves its stored list on `unavailable`, so the cached fingerprint still
    // describes what the server holds. Dropping it here would force a pointless full resend after
    // every transient `dpkg-query` timeout.
    const { fields, cache } = softwareWireFields({ state: "unavailable" }, HASH);
    expect(fields.software).toBeUndefined();
    expect(fields.softwareState).toBe("unavailable");
    expect(fields.softwareHash).toBeUndefined();
    expect(cache).toBe(HASH);
  });

  test("DISABLED sends no list and DROPS the cache — the server just cleared its copy", () => {
    // The mirror image of `unavailable`: the server clears on `disabled`, so a kept fingerprint would
    // make a later re-enable claim "unchanged" about a list the server no longer has.
    const { fields, cache } = softwareWireFields({ state: "disabled" }, HASH);
    expect(fields.software).toBeUndefined();
    expect(fields.softwareState).toBe("disabled");
    expect(fields.softwareHash).toBeUndefined();
    expect(cache).toBeUndefined();
  });

  test("a server that asked for a resend gets one: no cache in, the whole list out", () => {
    // How `softwareResend` on the ack takes effect — the agent simply forgets what it cached.
    const { fields } = softwareWireFields(reported, undefined);
    expect(fields.software).toEqual(PKGS);
  });
});
