"use client";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useInfraAutoConfirmRules } from "@/lib/api/hooks/use-infra-nodes";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";

/** The Topology screen, and its Table view where the Pending review tray (and its rules) live. */
const DIAGRAM_HREF = "/assets/diagram";
const SERVERS_HREF = "/assets/diagram?view=table";

/**
 * The three scopes, LEAST specific first — the order `resolveAgentPolicy` folds them in, so the row
 * order on screen is the resolution order rather than a presentation choice.
 *
 * `editable` is a statement about THIS BUILD, not about the API: `PUT /infra/agent-policy/service-
 * accounts/:id` and `PUT /infra/nodes/:id/agent-policy` both exist and both work; the web client has
 * a function for neither. Rendering the scopes and marking two of them unbuilt is the honest shape —
 * an operator who cannot see that the hierarchy exists cannot reason about why one host differs.
 */
const SCOPES = [
  { key: "instance", editable: true },
  { key: "serviceAccount", editable: false },
  { key: "node", editable: false },
] as const;

/**
 * Where a policy comes from — the three scopes as a ladder, least specific first, so the operator sees
 * *which* scope this page edits (of the three the server resolves) and that the narrower two have no
 * editor yet. Read-only. The "configured vs applied" story behind the save bar's tip, and the per-host
 * status lives on the infrastructure diagram, linked from the header (#1533 folded the old Rollout
 * block into those two places).
 */
export function AgentScopesPanel() {
  const t = useTranslations("settings.agentPolicy");

  return (
    <SettingsSection
      title={t("scopes.title")}
      summary={t("scopes.summary")}
      help={
        <>
          <p>{t("scopes.description")}</p>
          <p>{t("scopes.wizard")}</p>
          <p>{t("scopes.footer")}</p>
        </>
      }
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={DIAGRAM_HREF}>
            {t("rollout.link")}
            <ArrowTopRightOnSquareIcon className="size-4" />
          </Link>
        </Button>
      }
    >
      <ol className="grid gap-2 sm:grid-cols-3">
        {SCOPES.map(({ key, editable }, index) => (
          <li
            key={key}
            className={cn(
              "grid gap-1 rounded-lg px-3 py-2.5 ring-1 ring-inset",
              editable ? "ring-primary/50" : "ring-foreground/10",
            )}
          >
            <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              {index + 1} · {t(`scopes.${key}.label`)}
            </span>
            <span className="text-sm font-medium">{t(`scopes.${key}.scope`)}</span>
            <StatusBadge tone={editable ? "info" : "neutral"} className="mt-0.5">
              {t(editable ? "scopes.editedHere" : "scopes.noEditor")}
            </StatusBadge>
          </li>
        ))}
      </ol>
      <div
        className="flex items-center justify-between text-xs text-muted-foreground"
        aria-hidden
      >
        <span>{t("scopes.general")}</span>
        <span>{t("scopes.specific")} →</span>
      </div>
    </SettingsSection>
  );
}

/**
 * Auto-confirm rules (#1145), surfaced from the agent section — the other half of "how are my agents
 * configured?", and previously reachable only by someone already looking at the topology map.
 *
 * It LINKS rather than embeds. The rules editor is a dialog on the Pending review tray, where an
 * operator can see the proposals a rule would have swallowed; lifting it out of that context would
 * cost more than the second entry point is worth. What this panel owes the page is the count and the
 * route.
 *
 * The list read is `infra:read`, which `settings:manage` does not imply, so the query is gated on the
 * permission rather than allowed to 403 into an error state on a page it is not the subject of.
 */
export function AutoConfirmRulesPanel() {
  const t = useTranslations("settings.agentPolicy");
  const { can } = useMyPermissions();
  const canRead = can("infra:read");
  const { data, isLoading } = useInfraAutoConfirmRules(canRead);

  const total = data?.length ?? 0;
  const enabled = data?.filter((rule) => rule.enabled).length ?? 0;

  return (
    <SettingsSection
      title={t("autoConfirm.title")}
      // Silent when the caller cannot read the list: a count nobody is allowed to fetch is not an
      // error worth reporting on a page whose subject is the policy.
      summary={
        canRead && isLoading ? (
          <Skeleton className="h-4 w-40" />
        ) : canRead && data ? (
          total === 0 ? (
            t("autoConfirm.empty")
          ) : (
            t("autoConfirm.summary", { total, enabled })
          )
        ) : undefined
      }
      help={<p>{t("autoConfirm.description")}</p>}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={SERVERS_HREF}>
            {t("autoConfirm.manage")}
            <ArrowTopRightOnSquareIcon className="size-4" />
          </Link>
        </Button>
      }
    />
  );
}
