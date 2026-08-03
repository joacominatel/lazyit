import type { InfraNodeSource } from "@lazyit/shared";
import { getAgentContainerFacts } from "../../[id]/_components/agent-container-facts";
import { getAgentInventory } from "../../[id]/_components/agent-inventory-panel";

/**
 * Which tabs the node-detail modal opens with (issue #1182), and which `specs` projection its
 * reported-facts tab renders.
 *
 * The old right-hand rail stacked everything into one scroll: identity, badges, the editable fields,
 * the blast-radius toggle, the whole reported-facts block and the connections manager. Nothing on it
 * was wrong; it was UNDIFFERENTIATED — every fact carried the same weight, so an operator read all of
 * it to find one thing. Tabs only fix that if each tab answers a question someone actually arrives
 * with, and only if a tab that has no answer for THIS node is absent rather than empty.
 *
 * Hence a plan, not a fixed tab bar:
 *  - **general** / **connections** / **changes** apply to every node, hand-drawn or reported.
 *  - **facts** appears only when one of the two agent projections actually matches the blob, and
 *    `factsArm` names WHICH — so the modal renders the arm the projection chose rather than picking
 *    one from `source` and hoping.
 *  - **software** appears only for a host that reported a package list. A container reports none.
 *
 * The last two rules are the #1139 defect written down. `getAgentInventory` and
 * `getAgentContainerFacts` are deliberately disjoint (a host blob has `host.hostname`, a child blob
 * has `container.name`) and each DECLINES the other's shape by returning null — but "declines it" is
 * only half a fix if the caller then falls through to a raw `JSON.stringify` dump. Deriving the tab
 * from `source === "AGENT"` alone would rebuild exactly that: a facts tab opening onto a projection
 * that refuses to render. So the projections themselves decide, and a node whose blob matches
 * neither gets no facts tab at all.
 */
export type NodeDetailTabId =
  | "general"
  | "facts"
  | "software"
  | "connections"
  | "changes";

/** Which projection the reported-facts tab renders, or null when there is no such tab. */
export type NodeFactsArm = "host" | "container";

export interface NodeDetailTabPlan {
  /** The tabs to render, in display order. Always starts with `general`. */
  tabs: NodeDetailTabId[];
  /** The projection behind the `facts` tab; null exactly when `tabs` has no `facts`. */
  factsArm: NodeFactsArm | null;
}

/**
 * Plan the tab set for one node.
 *
 * `source` is checked first because reported facts are the AGENT's: the tab is labelled as a
 * check-in, and a hand-authored `specs` blob that happens to carry a `host` key is a custom field,
 * not a report. Within an agent node the host arm is tried first — the same order the old panel
 * used — which is a readability choice rather than a precedence one, because the arms cannot both
 * match.
 */
export function planNodeDetailTabs(node: {
  source: InfraNodeSource;
  specs: Record<string, unknown> | null | undefined;
}): NodeDetailTabPlan {
  const inventory =
    node.source === "AGENT" ? getAgentInventory(node.specs) : null;
  const container =
    node.source === "AGENT" && !inventory
      ? getAgentContainerFacts(node.specs)
      : null;

  const factsArm: NodeFactsArm | null = inventory
    ? "host"
    : container
      ? "container"
      : null;

  const tabs: NodeDetailTabId[] = ["general"];
  if (factsArm) tabs.push("facts");
  // Only a host reports packages, and only when the collector could read them — `software` is
  // optional in the contract, and an absent list is not an empty one (ADR-0074 §2). An EMPTY list
  // still earns the tab: "reports packages, currently reads none" is a fact worth a surface.
  if (inventory?.software !== undefined) tabs.push("software");
  tabs.push("connections", "changes");

  return { tabs, factsArm };
}
