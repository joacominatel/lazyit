"use client";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useInfraAutoConfirmRules } from "@/lib/api/hooks/use-infra-nodes";
import { useMyPermissions } from "@/lib/hooks/use-permissions";

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
 * Where a policy comes from, and how far it has actually travelled.
 *
 * Two panels that answer the questions the editor beside them cannot: *which* scope an operator is
 * editing (of the three the server resolves), and whether the fleet has picked the last change up.
 * Neither is editable — this is the read half of the section.
 */
export function AgentScopesPanel({ revision }: { revision: number | undefined }) {
  const t = useTranslations("settings.agentPolicy");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("scopes.title")}</CardTitle>
        <CardDescription>{t("scopes.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ol className="divide-y">
          {SCOPES.map(({ key, editable }) => (
            <li
              key={key}
              className="flex items-start justify-between gap-4 py-3 first:pt-0"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">{t(`scopes.${key}.label`)}</p>
                <p className="text-sm text-muted-foreground">
                  {t(`scopes.${key}.scope`)}
                </p>
              </div>
              <StatusBadge
                tone={editable ? "info" : "neutral"}
                className="mt-0.5 shrink-0"
              >
                {t(editable ? "scopes.editedHere" : "scopes.noEditor")}
              </StatusBadge>
            </li>
          ))}
        </ol>

        <p className="text-sm text-muted-foreground">{t("scopes.footer")}</p>

        <div className="space-y-3 border-t pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{t("rollout.title")}</h3>
            {revision === undefined ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <StatusBadge tone="neutral">
                {t("revisionBadge", { revision })}
              </StatusBadge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{t("rollout.body")}</p>
          <p className="text-sm text-muted-foreground">{t("rollout.legacy")}</p>
          <Button asChild variant="outline" size="sm">
            <Link href={DIAGRAM_HREF}>
              {t("rollout.link")}
              <ArrowTopRightOnSquareIcon className="size-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>{t("autoConfirm.title")}</CardTitle>
        <CardDescription>{t("autoConfirm.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Silent when the caller cannot read the list: a count nobody is allowed to fetch is not an
            error worth reporting on a page whose subject is the policy. */}
        {canRead && isLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : canRead && data ? (
          <p className="text-sm text-muted-foreground">
            {total === 0
              ? t("autoConfirm.empty")
              : t("autoConfirm.summary", { total, enabled })}
          </p>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link href={SERVERS_HREF}>
            {t("autoConfirm.manage")}
            <ArrowTopRightOnSquareIcon className="size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
