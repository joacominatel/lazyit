"use client";

import { InboxIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  LinkableRow,
  Pagination,
  type ResourceColumn,
  ResourceTable,
} from "@/components/resource-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableCell } from "@/components/ui/table";
import { useWorkflowTasks } from "@/lib/api/hooks/use-workflow-tasks";
import { useFormatters } from "@/lib/hooks/use-formatters";

const PAGE_SIZE = 20;

/**
 * The manual-task inbox (frontend.md §6a) — a `<ResourceTable>` of PENDING tasks across apps. Until the
 * ADR-0052 bell/SSE lands the list is POLLED (the hook refetches the pending queue on an interval), so a
 * new "needs a human" task surfaces without a reload. The task `prompt` is UNTRUSTED context (grantee
 * display name, free-form values) — it is rendered as escaped text ONLY (React default), never as HTML
 * (SEC-A5). Acting on a task is gated server-side by `workflow:task` + an assignee/cohort match.
 */
export function TasksInbox() {
  const t = useTranslations("workflow");
  const { relative } = useFormatters();
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, error, refetch, isFetching } =
    useWorkflowTasks({ status: "PENDING", limit: PAGE_SIZE, offset });

  const columns: ResourceColumn[] = [
    { key: "prompt", header: t("inbox.columns.task") },
    { key: "step", header: t("inbox.columns.step") },
    { key: "age", header: t("inbox.columns.age"), headClassName: "w-32" },
  ];

  if (isError) {
    return (
      <ErrorState
        title={t("inbox.errorTitle")}
        onRetry={() => refetch()}
        error={error}
      />
    );
  }

  const tasks = data?.items ?? [];

  if (!isLoading && tasks.length === 0 && offset === 0) {
    return (
      <EmptyState
        icon={InboxIcon}
        title={t("inbox.emptyTitle")}
        description={t("inbox.emptyDescription")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ResourceTable columns={columns} isLoading={isLoading} skeletonRows={5}>
        {tasks.map((task) => (
          <LinkableRow
            key={task.id}
            href={`/settings/integrations/tasks/${task.id}`}
          >
            <TableCell className="max-w-md">
              {/* SEC-A5: untrusted prompt rendered as escaped text only. */}
              <span className="line-clamp-2 break-words">{task.prompt}</span>
            </TableCell>
            <TableCell>
              <StatusBadge tone="neutral">{task.stepKey}</StatusBadge>
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {relative(task.createdAt)}
            </TableCell>
          </LinkableRow>
        ))}
      </ResourceTable>
      <Pagination
        total={data?.total ?? 0}
        limit={PAGE_SIZE}
        offset={offset}
        itemCount={tasks.length}
        onOffsetChange={setOffset}
        isFetching={isFetching}
      />
    </div>
  );
}
