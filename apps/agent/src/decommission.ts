/**
 * `lazyit-agent decommission` (#1701, epic #1146 Q11) — the agent's last word before the installer
 * removes it.
 *
 * The uninstall path of both installers runs this AFTER it has disarmed the scheduler and BEFORE it
 * destroys the token. It sends one ordinary, fully collected report with `decommissioning: true`, and
 * a server that understands the flag RETIRES the node this host's own reporting key resolves to. The
 * node is marked gone rather than left to sit OFFLINE and be announced as an outage. The server
 * touches nothing else: no other node, no child, and never the linked Asset.
 *
 * WHY A FULL REPORT, and not a slim one. An instance older than #1701 strips the flag (the report root
 * is a loose object, #1138) and ingests the request as an ordinary check-in. A slim report would then
 * be read as a host that lost its facts, and an omitted package list as one that has no software. A
 * full report is harmless to that server: it refreshes the node exactly as a normal tick would.
 *
 * WHY THE FLAG IS ADDED AFTER VALIDATION. `buildReport` validates against the shared
 * `AgentReportSchema`, whose root strips keys it does not know. Adding the flag afterwards keeps this
 * build working whether or not its shared contract already declares the field.
 *
 * Everything here is PURE: the payload shape and the reading of the answer. The I/O lives in
 * `index.ts`, which is what lets these be tested without a server.
 */

/** The wire key the server reads (`AgentReportSchema.decommissioning`). */
export const DECOMMISSION_FIELD = "decommissioning";

/** The report, flagged as this host's last. */
export function decommissionPayload<T extends object>(
  report: T,
): T & { decommissioning: true } {
  return { ...report, [DECOMMISSION_FIELD]: true } as T & { decommissioning: true };
}

/** What the server's answer means for the operator running the uninstall. */
export type DecommissionOutcome =
  /** The node is retired. `nodeId` names it when the ack carried one. */
  | { kind: "retired"; nodeId?: string }
  /**
   * 2xx without `retired: true`: an instance that predates #1701 took the report as an ordinary
   * check-in. Nothing is retired; the node will go OFFLINE and be announced like any silent host.
   */
  | { kind: "unsupported"; nodeId?: string }
  /** 404: no live node carries this host's key — it never reported, or it was discarded. */
  | { kind: "unknownHost" }
  /** Anything else: the instance refused or failed. Nothing is known to have been retired. */
  | { kind: "rejected"; status: number; detail: string };

/** Read the server's answer. Tolerant of any body: an unparseable ack is "unsupported", never a crash. */
export function interpretDecommission(
  status: number,
  ack: unknown,
  bodyText = "",
): DecommissionOutcome {
  if (status === 404) return { kind: "unknownHost" };
  if (status < 200 || status >= 300) {
    return { kind: "rejected", status, detail: bodyText.slice(0, 500) };
  }
  const record = ack !== null && typeof ack === "object" ? (ack as Record<string, unknown>) : {};
  const nodeId = typeof record.nodeId === "string" ? record.nodeId : undefined;
  if (record.retired === true) {
    return nodeId !== undefined ? { kind: "retired", nodeId } : { kind: "retired" };
  }
  return nodeId !== undefined ? { kind: "unsupported", nodeId } : { kind: "unsupported" };
}

/**
 * The line the operator reads, and whether the command succeeded. Only `retired` succeeds: every other
 * outcome leaves the node exactly as it was, and the operator is told how to finish by hand.
 */
export function describeDecommission(outcome: DecommissionOutcome): { ok: boolean; message: string } {
  switch (outcome.kind) {
    case "retired":
      return {
        ok: true,
        message:
          `this host's node${outcome.nodeId ? ` (${outcome.nodeId})` : ""} is RETIRED in lazyit — it keeps its history and ` +
          "is no longer watched for liveness. If this host ever reports again, it is un-retired automatically.",
      };
    case "unsupported":
      return {
        ok: false,
        message:
          "your lazyit instance predates decommissioning (#1701) and recorded this as an ordinary report, so " +
          "nothing was retired. Retire the node by hand in lazyit, or it will go OFFLINE and be announced.",
      };
    case "unknownHost":
      return {
        ok: false,
        message:
          "lazyit has no live node for this host (it never reported, or its node was discarded) — there is nothing to retire.",
      };
    case "rejected":
      return {
        ok: false,
        message:
          `the decommissioning report was refused (${outcome.status})${outcome.detail ? `: ${outcome.detail}` : ""}. ` +
          "Nothing was retired — retire the node by hand in lazyit.",
      };
  }
}
