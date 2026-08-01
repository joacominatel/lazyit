/**
 * The agent's half of the software delta (ADR-0074 §2/§7 amendment, issue #1142).
 *
 * The installed-package list is the whole weight of a report: a real Linux server measures ~350 KB of
 * it against a few KB of everything else, and it changes when somebody runs `apt upgrade` — perhaps
 * twice a month. Sending it on every check-in is ~96 full transfers a day, per host, of bytes the
 * server already has.
 *
 * So the agent fingerprints the list it collected, caches that fingerprint in `state.json`, and OMITS
 * the list when it matches — while always sending the fingerprint, so "unchanged" is a claim the
 * server can corroborate rather than one it has to trust.
 *
 * The rule this file exists to keep straight is which outcomes may drop the cache. `unavailable` and
 * `disabled` look alike from here (neither sends a list) and are opposites on the server: it PRESERVES
 * its stored list on the first and CLEARS it on the second. So a cached fingerprint stays accurate
 * through `unavailable` and becomes a lie through `disabled` — see {@link softwareWireFields}.
 */
import { softwareFingerprint, type AgentReport, type AgentSoftwareState } from "@lazyit/shared";

type Software = NonNullable<AgentReport["software"]>;

/**
 * What the collector managed to do this run. Three outcomes, because the wire has three answers
 * (`AgentSoftwareStateSchema`) and collapsing any two of them is how an inventory silently rots or
 * silently empties.
 */
export type SoftwareCollection =
  | { state: "reported"; software: Software }
  | { state: "unavailable" }
  | { state: "disabled" };

/** The software-related fields one report carries. `software` is absent unless it is being sent. */
export interface SoftwareWireFields {
  software?: Software;
  softwareState: AgentSoftwareState;
  softwareHash?: string;
}

/**
 * Decide what this report says about software, and what the agent should remember afterwards.
 *
 * `cache` is the fingerprint to persist once the report is ACCEPTED — never before, because a report
 * the server rejected changed nothing about what the server holds, and caching a fingerprint for a
 * list that never landed is exactly how a delta scheme starts lying.
 */
export function softwareWireFields(
  collection: SoftwareCollection,
  cachedHash: string | undefined,
): { fields: SoftwareWireFields; cache: string | undefined } {
  if (collection.state === "disabled") {
    // The server clears its stored list for this one, so the cached fingerprint no longer describes
    // anything. Keeping it would make a later re-enable open with "unchanged" about a list the server
    // does not have — recoverable (the server asks for a resend) but a wasted round trip and a tick
    // of an empty panel, both of which are free to avoid here.
    return { fields: { softwareState: "disabled" }, cache: undefined };
  }
  if (collection.state === "unavailable") {
    // The server PRESERVES on this one, so what it holds is still the list the cached fingerprint
    // describes. Dropping the cache would force a full resend after every transient collector
    // timeout, which is the cost this whole change exists to remove.
    return { fields: { softwareState: "unavailable" }, cache: cachedHash };
  }
  const softwareHash = softwareFingerprint(collection.software);
  if (cachedHash !== undefined && cachedHash === softwareHash) {
    return { fields: { softwareState: "unchanged", softwareHash }, cache: softwareHash };
  }
  return {
    fields: { software: collection.software, softwareState: "reported", softwareHash },
    cache: softwareHash,
  };
}
