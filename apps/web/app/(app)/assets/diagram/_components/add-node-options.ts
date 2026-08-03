/**
 * The "add" paths the Topology screen offers, in the order it offers them (issue #1181).
 *
 * `agent` opens the reporting-agent wizard — the flow that mints the `infra:report` Service Account
 * and hands over the platform-appropriate install command. `manual` opens the create-node form, the
 * hand-drawn card that has been the Map's only path since ADR-0070.
 *
 * The order is the point of the issue. A reporting agent self-populates its node, keeps it current
 * and lets it go OFFLINE on its own when the host stops checking in; a hand-drawn node is accurate
 * for exactly as long as someone remembers to edit it. So the agent leads, and manual is the
 * fallback for the things that cannot run one — a switch, a firewall, a NAS. The Map used to offer
 * only the fallback.
 *
 * The two paths carry different permissions and neither implies the other: minting the agent's
 * Service Account needs `settings:manage` — every `/service-accounts` route is gated on it
 * (ADR-0048) — while putting a node on the map needs `infra:manage`. ADR-0074 §5 is about the
 * permission the minted account HOLDS (`infra:report`, and only that); it says nothing about who may
 * mint one. The caller renders exactly what comes back — an option that is not returned is not
 * shown disabled, because a menu entry an operator cannot use teaches them nothing the API would not
 * have told them anyway.
 */
export type AddNodeOption = "agent" | "manual";

export function addNodeOptions({
  canCreateAgent,
  canCreateManual,
}: {
  /** `settings:manage` — the permission that can mint the agent's Service Account. */
  canCreateAgent: boolean;
  /** `infra:manage` — the permission that can put a node on the map. */
  canCreateManual: boolean;
}): AddNodeOption[] {
  const options: AddNodeOption[] = [];
  if (canCreateAgent) options.push("agent");
  if (canCreateManual) options.push("manual");
  return options;
}
