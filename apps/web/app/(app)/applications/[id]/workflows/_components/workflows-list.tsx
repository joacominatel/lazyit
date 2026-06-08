"use client";

import {
  Cog6ToothIcon,
  PencilSquareIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { ApplicationWorkflow } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
import { EmptyState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { notifyError } from "@/lib/api/notify-error";
import { useUpdateWorkflow } from "@/lib/api/hooks/use-workflow-mutations";
import { useWorkflow, useWorkflows } from "@/lib/api/hooks/use-workflows";
import { useWorkflowRuns } from "@/lib/api/hooks/use-workflow-runs";
import { useCan } from "@/lib/hooks/use-permissions";
import { runStatusTone } from "@/lib/workflow/status";

/**
 * The per-application workflows list (frontend.md §2a) — one row per (trigger) workflow with the trigger
 * badge, the enabled toggle, step count and last-run status. Most apps have 0–2 workflows, so this is a
 * short list, not a paginated table. When none exist it shows the LOUD "no automation configured —
 * grants are recorded only" empty state, so the UX never implies automation where none is set up.
 * Manage affordances (toggle, new, edit) are gated on `workflow:manage`.
 */
export function WorkflowsList({ applicationId }: { applicationId: string }) {
  const t = useTranslations("workflow");
  const canManage = useCan("workflow:manage");
  const { data, isLoading } = useWorkflows({ applicationId, limit: 50 });

  const workflows = data?.items ?? [];

  return (
    <DetailPanel
      title={t("list.title")}
      actions={
        canManage && workflows.length > 0 ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={`/applications/${applicationId}/workflows/new`}>
              <PlusIcon />
              {t("list.addWorkflow")}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : workflows.length === 0 ? (
        <EmptyState
          icon={Cog6ToothIcon}
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            canManage ? (
              <Button size="sm" asChild>
                <Link href={`/applications/${applicationId}/workflows/new`}>
                  <PlusIcon />
                  {t("list.addWorkflow")}
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y">
          {workflows.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              applicationId={applicationId}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}

function WorkflowRow({
  workflow,
  applicationId,
  canManage,
}: {
  workflow: ApplicationWorkflow;
  applicationId: string;
  canManage: boolean;
}) {
  const t = useTranslations("workflow");
  const update = useUpdateWorkflow();
  // Step count + last-run status enrich the row; cheap + cached for these tiny lists.
  const { data: detail } = useWorkflow(workflow.id);
  const { data: runs } = useWorkflowRuns({
    workflowId: workflow.id,
    limit: 1,
  });

  const stepCount = detail?.latestVersion?.steps.length ?? 0;
  const lastRun = runs?.items[0];

  function toggleEnabled(enabled: boolean) {
    update.mutate(
      { id: workflow.id, data: { enabled } },
      {
        onSuccess: () =>
          toast.success(
            enabled ? t("list.toastEnabled") : t("list.toastDisabled"),
          ),
        onError: (err) => notifyError(err, t("list.toastError")),
      },
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/applications/${applicationId}/workflows/${workflow.id}/edit`}
            className="truncate font-medium hover:underline"
          >
            {workflow.name}
          </Link>
          <StatusBadge tone="info">
            {t(`triggers.${workflow.trigger}`)}
          </StatusBadge>
          {!workflow.enabled ? (
            <StatusBadge tone="neutral">{t("list.disabled")}</StatusBadge>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("list.stepCount", { count: stepCount })}
          {lastRun ? (
            <>
              {" · "}
              {t("list.lastRun", { status: t(`runStatus.${lastRun.status}`) })}
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {lastRun ? (
          <Link
            href={`/applications/${applicationId}/workflows/runs/${lastRun.id}`}
          >
            <StatusBadge tone={runStatusTone(lastRun.status)}>
              {t(`runStatus.${lastRun.status}`)}
            </StatusBadge>
          </Link>
        ) : null}
        {canManage ? (
          <>
            <Switch
              checked={workflow.enabled}
              onCheckedChange={toggleEnabled}
              disabled={update.isPending}
              aria-label={t("list.toggleAria", { name: workflow.name })}
            />
            <Button size="icon-sm" variant="ghost" asChild>
              <Link
                href={`/applications/${applicationId}/workflows/${workflow.id}/edit`}
                aria-label={t("list.editAria", { name: workflow.name })}
              >
                <PencilSquareIcon />
              </Link>
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
