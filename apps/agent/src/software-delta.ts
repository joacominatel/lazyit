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
 *
 * AND THE OMISSION IS GATED ON A HANDSHAKE, not on the agent's own belief. `AgentReportSchema`'s root
 * is a LOOSE `z.object()` — the #1138 decision that stops a newer agent from 400-ing itself off the
 * map — so a server built before #1142 does not REJECT `softwareState`/`softwareHash`, it silently
 * STRIPS them. It then sees no `software` key, reads that the only way it knows how, and clears the
 * stored list. An agent that omitted its list there would wipe the host's inventory, and because it
 * believes the list unchanged it would never send it again: permanent loss, no error anywhere. So the
 * list is withheld only once an ack has stated the server understands the contract — see
 * {@link serverUnderstandsSoftwareDelta}. Until then the whole list rides every report, which costs
 * exactly what the pre-#1142 agent cost.
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
 * Does this ack come from a server that understands the three-state contract (#1142)?
 *
 * The ack body is remote input and the agent reads it loosely — named keys off the parsed JSON, never
 * a schema — so this accepts a LITERAL `true` and nothing else: a truthy string, a `1`, a missing body
 * and an ack that failed to parse all read as "not proven". Getting this wrong in the permissive
 * direction is the one mistake that costs an operator their inventory, so it is deliberately the
 * strictest read in the file.
 *
 * It is also how the handshake heals DOWNWARDS. An instance rolled back below #1142 stops sending the
 * key, this returns false for that ack, the agent forgets the evidence, and its next report carries
 * the full list again — one report of exposure, self-repaired, rather than permanent silent loss.
 */
export function serverUnderstandsSoftwareDelta(ack: unknown): boolean {
  return (
    typeof ack === "object" &&
    ack !== null &&
    (ack as { softwareDelta?: unknown }).softwareDelta === true
  );
}

/**
 * Decide what this report says about software, and what the agent should remember afterwards.
 *
 * `cache` is the fingerprint to persist once the report is ACCEPTED — never before, because a report
 * the server rejected changed nothing about what the server holds, and caching a fingerprint for a
 * list that never landed is exactly how a delta scheme starts lying.
 *
 * `serverUnderstandsDelta` is the handshake, and it is a REQUIRED argument rather than a defaulted one
 * so that no future call site can acquire the destructive behaviour by forgetting a parameter. When it
 * is false the collected list is sent in full even though the fingerprint matches — the failure mode
 * of this whole scheme is "sent more than necessary", never "deleted the operator's inventory".
 *
 * It gates ONLY the `unchanged` branch, because that is the only one whose absence a server could read
 * as a durable "no software". `unavailable` and `disabled` carry no list with or without the
 * handshake, so gating them would change nothing on the wire and would only cost the cache. An OLD
 * server reads both as the pre-#1142 absent key and clears — which is exactly right for `disabled`,
 * and for `unavailable` empties the panel until the next successful collection, which sends the whole
 * list again because this agent has no evidence against that server. That is EXACTLY what a pre-#1142
 * agent did in the same situation, and the two cases were never distinguishable: `applySoftwarePolicy`
 * returned `undefined` — never `[]` — both when the collector enumerated nothing and when policy
 * turned software collection off, and the report spread `...(software ? { software } : {})`, so both
 * left the key ABSENT and both made the server clear. Neither branch is worse than what the estate
 * already runs. Only `unchanged` can cost an inventory permanently, and only `unchanged` is gated.
 */
export function softwareWireFields(
  collection: SoftwareCollection,
  cachedHash: string | undefined,
  serverUnderstandsDelta: boolean,
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
  if (serverUnderstandsDelta && cachedHash !== undefined && cachedHash === softwareHash) {
    return { fields: { softwareState: "unchanged", softwareHash }, cache: softwareHash };
  }
  // Either the list moved, or this server has not proved it can read an omission. Send everything —
  // and KEEP the fingerprint either way, so the first ack from an upgraded instance is enough to start
  // saving on the run after it, with no resend round trip to earn the delta back.
  return {
    fields: { software: collection.software, softwareState: "reported", softwareHash },
    cache: softwareHash,
  };
}
