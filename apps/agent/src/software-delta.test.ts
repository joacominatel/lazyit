import { describe, expect, test } from "bun:test";
import { softwareFingerprint } from "@lazyit/shared";
import {
  serverUnderstandsSoftwareDelta,
  softwareWireFields,
  type SoftwareCollection,
} from "./software-delta";

const PKGS = [
  { name: "nginx", version: "1.27.0", source: "dpkg" as const },
  { name: "redis", version: "7.2", source: "dpkg" as const },
];
const HASH = softwareFingerprint(PKGS);

const reported: SoftwareCollection = { state: "reported", software: PKGS };

/** A server that has proved it understands `softwareState` — see the handshake block below. */
const PROVEN = true;
/** A server that has not. Every pre-#1142 server, and every server not yet heard from. */
const UNPROVEN = false;

describe("softwareWireFields — the client half of the delta (#1142)", () => {
  test("a first run has no cached fingerprint, so it sends the whole list", () => {
    const { fields, cache } = softwareWireFields(reported, undefined, PROVEN);
    expect(fields.software).toEqual(PKGS);
    expect(fields.softwareState).toBe("reported");
    expect(fields.softwareHash).toBe(HASH);
    expect(cache).toBe(HASH);
  });

  test("an UNCHANGED list is omitted but still fingerprinted — the ~90% steady-state saving", () => {
    const { fields, cache } = softwareWireFields(reported, HASH, PROVEN);
    expect(fields.software).toBeUndefined();
    expect(fields.softwareState).toBe("unchanged");
    // The fingerprint always rides along: without it the server has nothing to corroborate the claim
    // against, and "unchanged" would be a client assertion the server had to take on faith.
    expect(fields.softwareHash).toBe(HASH);
    expect(cache).toBe(HASH);
  });

  test("a CHANGED list is sent in full again", () => {
    const { fields, cache } = softwareWireFields(
      reported,
      "1-2-staleeeeeeeeeeeeeeeeeeeeeeee",
      PROVEN,
    );
    expect(fields.software).toEqual(PKGS);
    expect(fields.softwareState).toBe("reported");
    expect(cache).toBe(HASH);
  });

  test("an EMPTY list is REPORTED, not omitted — 'the policy filtered everything' is a finding", () => {
    const { fields } = softwareWireFields(
      { state: "reported", software: [] },
      undefined,
      PROVEN,
    );
    expect(fields.software).toEqual([]);
    expect(fields.softwareState).toBe("reported");
  });

  test("UNAVAILABLE sends no list and no fingerprint, and KEEPS the cached one", () => {
    // The server preserves its stored list on `unavailable`, so the cached fingerprint still
    // describes what the server holds. Dropping it here would force a pointless full resend after
    // every transient `dpkg-query` timeout.
    const { fields, cache } = softwareWireFields({ state: "unavailable" }, HASH, PROVEN);
    expect(fields.software).toBeUndefined();
    expect(fields.softwareState).toBe("unavailable");
    expect(fields.softwareHash).toBeUndefined();
    expect(cache).toBe(HASH);
  });

  test("DISABLED sends no list and DROPS the cache — the server just cleared its copy", () => {
    // The mirror image of `unavailable`: the server clears on `disabled`, so a kept fingerprint would
    // make a later re-enable claim "unchanged" about a list the server no longer has.
    const { fields, cache } = softwareWireFields({ state: "disabled" }, HASH, PROVEN);
    expect(fields.software).toBeUndefined();
    expect(fields.softwareState).toBe("disabled");
    expect(fields.softwareHash).toBeUndefined();
    expect(cache).toBeUndefined();
  });

  test("a server that asked for a resend gets one: no cache in, the whole list out", () => {
    // How `softwareResend` on the ack takes effect — the agent simply forgets what it cached.
    const { fields } = softwareWireFields(reported, undefined, PROVEN);
    expect(fields.software).toEqual(PKGS);
  });
});

/**
 * THE CROSS-VERSION MATRIX (#1142) — the reason the omission is gated on a handshake rather than on
 * the agent's own belief.
 *
 * `AgentReportSchema`'s root is a LOOSE `z.object()` (the #1138 decision that stops a newer agent from
 * 400-ing itself off the map). An older server therefore does not reject `softwareState`/`softwareHash`
 * — it silently STRIPS them, sees no `software` key, and clears the stored list the only way it knows
 * how. An agent that omitted its list there would wipe the host's inventory, and because it believes
 * the list unchanged it would never send it again: permanent loss, no error anywhere.
 *
 * So the agent omits nothing until an ack has told it the server understands the three-state contract.
 * The failure mode is always "sent more than necessary", never "deleted the operator's inventory".
 */
describe("the capability handshake — new agent, old server (#1142)", () => {
  test("NEW AGENT → OLD SERVER: with no evidence the whole list rides EVERY report", () => {
    // The wipe case, from the client side. A matching fingerprint is exactly the situation in which
    // the agent would like to omit — and precisely the one in which omitting is destructive.
    const { fields, cache } = softwareWireFields(reported, HASH, UNPROVEN);
    expect(fields.software).toEqual(PKGS);
    expect(fields.softwareState).toBe("reported");
    // The fingerprint still travels: it costs 30 bytes, it is what the server stamps its own reading
    // against, and an old server strips it harmlessly.
    expect(fields.softwareHash).toBe(HASH);
    // …and the cache is still kept, so the very first ack from an upgraded instance is enough to
    // start saving on the run after it. No resend is needed to earn the delta back.
    expect(cache).toBe(HASH);
  });

  test("NEW AGENT → NEW SERVER, first contact: still sends everything, because the ack arrives after", () => {
    // A run only learns the capability from the ack it has not received yet, so run 1 is always a
    // full send. That one wasted payload is the entire price of the guarantee.
    const first = softwareWireFields(reported, HASH, UNPROVEN);
    expect(first.fields.software).toEqual(PKGS);
    // Run 2, now holding the evidence the ack carried, omits.
    const second = softwareWireFields(reported, first.cache, PROVEN);
    expect(second.fields.software).toBeUndefined();
    expect(second.fields.softwareState).toBe("unchanged");
  });

  test("a server that STOPS advertising the capability is answered with a full list again", () => {
    // The instance rolled back below #1142. The agent drops the evidence on that ack and its next
    // report carries everything, so the exposure is one report, not a permanent empty panel.
    const { fields } = softwareWireFields(reported, HASH, UNPROVEN);
    expect(fields.software).toEqual(PKGS);
  });

  test("`unavailable` and `disabled` are unaffected — neither has a list to withhold", () => {
    // Both send no list with or without the handshake, which is byte-for-byte what a pre-#1142 agent
    // did when its collector failed or its policy turned software off. Gating them would change
    // nothing on the wire and would only cost the cache.
    expect(softwareWireFields({ state: "unavailable" }, HASH, UNPROVEN)).toEqual(
      softwareWireFields({ state: "unavailable" }, HASH, PROVEN),
    );
    expect(softwareWireFields({ state: "disabled" }, HASH, UNPROVEN)).toEqual(
      softwareWireFields({ state: "disabled" }, HASH, PROVEN),
    );
  });
});

describe("serverUnderstandsSoftwareDelta — reading the evidence off an ack (#1142)", () => {
  const ack = { nodeId: "node-1", state: "CONFIRMED" };

  test("an ack from a pre-#1142 server proves nothing", () => {
    expect(serverUnderstandsSoftwareDelta(ack)).toBe(false);
  });

  test("only a literal `true` counts — the ack body is remote input, not a trusted object", () => {
    expect(serverUnderstandsSoftwareDelta({ ...ack, softwareDelta: true })).toBe(true);
    expect(serverUnderstandsSoftwareDelta({ ...ack, softwareDelta: "true" })).toBe(false);
    expect(serverUnderstandsSoftwareDelta({ ...ack, softwareDelta: 1 })).toBe(false);
    expect(serverUnderstandsSoftwareDelta({ ...ack, softwareDelta: false })).toBe(false);
  });

  test("an unparseable ack proves nothing rather than throwing", () => {
    // `res.json()` failing is a `null` here, and the report still SUCCEEDED — the agent must keep
    // its clock and simply not learn anything new.
    expect(serverUnderstandsSoftwareDelta(null)).toBe(false);
    expect(serverUnderstandsSoftwareDelta(undefined)).toBe(false);
    expect(serverUnderstandsSoftwareDelta("nope")).toBe(false);
  });
});
