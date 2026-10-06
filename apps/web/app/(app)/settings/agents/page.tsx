"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAgentPolicy } from "@/lib/api/hooks/use-agent-policy";
import { AdminGate } from "../_components/admin-gate";
import {
  AgentScopesPanel,
  AutoConfirmRulesPanel,
} from "./_components/agent-context-panels";
import { AgentPolicyEditor } from "./_components/agent-policy-editor";

/**
 * Settings → Reporting agents (#1174) — the section the agent surface never had.
 *
 * WHY IT IS ITS OWN ROUTE. The instance-default policy was one flat card inside Settings → Instance,
 * the auto-confirm rules were a dialog on the topology map, and two of the three policy scopes the
 * server resolves had no representation at all. An operator asking "how are my agents configured?"
 * had no page to open. `service-accounts`, `taxonomies`, `roles` and `integrations` already
 * establish the sibling-section pattern; this is the missing sibling, not a new concept.
 *
 * One column since #1533, in reading order: the editable instance-default policy in three groups
 * (cadence · what is collected · exclusions), the scopes ladder that says which of the three scopes
 * this page edits, the shared save bar, and the auto-confirm rules' entry point last — it is a
 * separate subject with its own home on the Servers view.
 *
 * NOT an ADR-0067 server-prefetch route, deliberately: `getAgentPolicy` takes no access token (it
 * resolves one from the client session store), so a Server Component prefetch would fire
 * unauthenticated and be swallowed — buying a wasted round-trip rather than a faster first paint.
 * The Settings hub skips prefetch for the same class of reason.
 */
export default function AgentsSettingsPage() {
  const t = useTranslations("settings");
  // Shares the `useAgentPolicy` cache entry with the editor below — one request, read twice, so the
  // header badge can never disagree with the revision the editor seeded its fields from.
  const { data } = useAgentPolicy();

  return (
    <AdminGate>
      <div className="max-w-3xl space-y-6">
        <PageHeader
          title={t("agentPolicy.title")}
          subtitle={t("agentPolicy.subtitle")}
          // Explicit crumbs rather than the path-derived default: the derived labels come from a
          // title-cased URL segment, which is English on every locale and would read "Agents" beside
          // a page titled "Reporting agents".
          badge={
            data ? (
              <StatusBadge tone="neutral">
                {t("agentPolicy.revisionBadge", { revision: data.revision })}
              </StatusBadge>
            ) : null
          }
        />

        <AgentPolicyEditor context={<AgentScopesPanel />} />
        <AutoConfirmRulesPanel />
      </div>
    </AdminGate>
  );
}
