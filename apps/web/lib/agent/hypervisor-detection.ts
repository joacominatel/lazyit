/**
 * The wizard's step-3 hypervisor detection feedback (#1225) — pure derivations over data the wait
 * step already fetches, so telling the operator "this host is a hypervisor, N guests await review"
 * costs NO new endpoint and no wire-contract change:
 *
 *  - The **facet** comes off the found node's drill-in (`GET /infra/nodes/:id`), whose `specs`
 *    deliberately keeps the full ADR-0074 blob — one fetch, once, when the awaited host appears.
 *    The list row cannot carry it: #1135 stripped `specs` from the polled list precisely because
 *    the blob is megabytes on a real host, and re-projecting one jsonb path per row would put the
 *    whole blob back on the server's read path every 5s.
 *  - The **guest count** comes from the PENDING list the wait step is ALREADY polling: ADR-0095 §5
 *    enrols a hypervisor's guests as PENDING children keyed `<host externalId>/guest/<ref>`, in the
 *    same report that enrols the host — so they are sitting in the very response that revealed the
 *    host, and counting them is a prefix match, not a request.
 *
 * Read-tolerant throughout (`specs` is jsonb typed `unknown` on the wire): every malformed shape
 * degrades to "no facet", never a throw — the celebration screen must not crash on a legacy blob.
 */
import { guestExternalIdPrefix } from "@lazyit/shared";

/** The slice of the ADR-0095 host facet the wizard shows: the platform, and a version when sent. */
export type DetectedHypervisor = {
  platform: string;
  version?: string;
};

/**
 * The ADR-0095 hypervisor facet off a node detail's `specs` blob (`specs.host.hypervisor`), or null
 * when the host did not report one — which is the overwhelmingly normal case and simply means "not
 * a hypervisor" to this UI (absence of the probe vs. absence of a hypervisor is a server-side
 * distinction the wizard has no use for).
 */
export function hypervisorFacetOf(specs: unknown): DetectedHypervisor | null {
  if (typeof specs !== "object" || specs === null) return null;
  const host = (specs as Record<string, unknown>).host;
  if (typeof host !== "object" || host === null) return null;
  const hypervisor = (host as Record<string, unknown>).hypervisor;
  if (typeof hypervisor !== "object" || hypervisor === null) return null;
  const { platform, version } = hypervisor as Record<string, unknown>;
  if (typeof platform !== "string" || platform.length === 0) return null;
  // A malformed version costs the FACT, never the facet — the same degrade posture as the wire.
  return typeof version === "string" && version.length > 0
    ? { platform, version }
    : { platform };
}

/**
 * The display name of an `AgentHypervisorPlatformSchema` member — the installers' own banner
 * spelling ("Detected: Proxmox VE …"), which the Manual uses too, so the platform has ONE name
 * across every surface. Null for `other` (and anything unrecognized): the caller renders its
 * generic "this host is a hypervisor" copy instead of leaking a raw enum member to an operator.
 */
export function hypervisorPlatformLabel(platform: string): string | null {
  switch (platform) {
    case "proxmox":
      return "Proxmox VE";
    case "hyperv":
      return "Hyper-V";
    case "libvirt":
      return "libvirt/KVM";
    case "xcpng":
      return "XCP-ng";
    default:
      return null;
  }
}

/**
 * How many of the PENDING rows are guest children of THIS host (ADR-0095 §5's
 * `<host externalId>/guest/<ref>` key rule, matched through the shared helper so the separator has
 * exactly one definition). Guarded on a missing/empty host key: `guestExternalIdPrefix("")` is the
 * bare separator, which every guest key of every host contains — an unguarded match would claim
 * all of them.
 */
export function countPendingGuests(
  hostExternalId: string | null | undefined,
  pending: readonly { externalId: string | null }[],
): number {
  if (!hostExternalId) return 0;
  const prefix = guestExternalIdPrefix(hostExternalId);
  return pending.filter((node) => node.externalId?.startsWith(prefix)).length;
}
