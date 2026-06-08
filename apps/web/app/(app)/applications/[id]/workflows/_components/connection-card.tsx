"use client";

import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { WorkflowConnection, WorkflowSecret } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeleteWorkflowConnection, useWorkflowConnections } from "@/lib/api/hooks/use-workflow-connections";
import { useWorkflowSecrets } from "@/lib/api/hooks/use-workflow-secrets";
import { useCan } from "@/lib/hooks/use-permissions";
import { ConfirmDialog } from "./confirm-dialog";
import { ConnectionFormDialog } from "./connection-form-dialog";
import { ConnectionTest } from "./connection-test";
import { StepKindBadge } from "./workflow-graph";
import { WorkflowSecretField } from "./workflow-secret-field";

/** Pick the redacted secret descriptor linked to a connection (by id, else by connectionId). */
function secretForConnection(
  connection: WorkflowConnection,
  secrets: WorkflowSecret[] | undefined,
): WorkflowSecret | undefined {
  if (!secrets) return undefined;
  if (connection.secretId) {
    const byId = secrets.find((s) => s.id === connection.secretId);
    if (byId) return byId;
  }
  return secrets.find((s) => s.connectionId === connection.id);
}

/**
 * The per-application connection card (frontend.md §2a / §4) — "how do we reach this system + with what
 * credential". Shows the configured connection (kind, target URL, auth) + the WRITE-ONLY credential
 * field, or a loud "no automation configured" entry point. Manage actions are gated on `workflow:manage`;
 * the credential field gates itself on `workflow:secrets` (separation of duties).
 *
 * v1 models one connection per application (the common case); the first is shown.
 */
export function ConnectionCard({ applicationId }: { applicationId: string }) {
  const t = useTranslations("workflow");
  const canManage = useCan("workflow:manage");

  const { data: connections, isLoading } = useWorkflowConnections(applicationId);
  const { data: secrets } = useWorkflowSecrets(applicationId);
  const deleteConnection = useDeleteWorkflowConnection();

  const [formOpen, setFormOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const connection = connections?.[0];

  return (
    <DetailPanel
      title={t("connection.title")}
      actions={
        canManage && connection ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFormOpen(true)}
            >
              <PencilSquareIcon />
              {t("connection.edit")}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("connection.deleteAria")}
              onClick={() => setDeleteOpen(true)}
            >
              <TrashIcon />
            </Button>
          </div>
        ) : undefined
      }
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !connection ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("connection.none")}
          </p>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
              <PlusIcon />
              {t("connection.add")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <DetailField label={t("connection.kindLabel")}>
              <StepKindBadge kind={connection.kind} />
            </DetailField>
            <DetailField label={t("connection.nameLabel")}>
              {connection.name}
            </DetailField>
            {connection.config.kind === "REST" ? (
              <>
                <DetailField label={t("connection.baseUrlLabel")}>
                  <span className="break-all">{connection.config.baseUrl}</span>
                </DetailField>
                <DetailField label={t("connection.authLabel")}>
                  {t(`authScheme.${connection.config.authScheme}`)}
                </DetailField>
              </>
            ) : null}
            {connection.config.kind === "WEBHOOK_OUT" ? (
              <DetailField label={t("connection.webhookUrlLabel")}>
                <span className="break-all">{connection.config.url}</span>
              </DetailField>
            ) : null}
          </dl>

          {connection.kind !== "MANUAL" ? (
            <div className="space-y-1.5 border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground">
                {t("connection.secretLabel")}
              </p>
              <WorkflowSecretField
                applicationId={applicationId}
                connectionId={connection.id}
                secret={secretForConnection(connection, secrets)}
                defaultLabel={connection.name}
              />
            </div>
          ) : null}

          {canManage ? <ConnectionTest connectionId={connection.id} /> : null}
        </div>
      )}

      <ConnectionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        applicationId={applicationId}
        connection={connection}
      />
      {connection ? (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t("connection.deleteTitle")}
          description={t("connection.deleteDescription", {
            name: connection.name,
          })}
          confirmLabel={t("connection.deleteConfirm")}
          destructive
          onConfirm={() => deleteConnection.mutateAsync(connection.id)}
        />
      ) : null}
    </DetailPanel>
  );
}
