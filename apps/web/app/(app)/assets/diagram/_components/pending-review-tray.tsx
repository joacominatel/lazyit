"use client";

import {
  CheckIcon,
  InboxArrowDownIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { InfraNodeListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useDeleteInfraNode,
  useInfraNodes,
} from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import { AgentBadge, AgentFreshness } from "./agent-provenance";
import { ConfirmNodeDialog } from "./confirm-node-dialog";
import { DeleteNodeDialog } from "./delete-node-dialog";

/**
 * The PENDING review tray (ADR-0074 §3) — the human gate over agent-discovered hosts. The reporting
 * agent lands every new host as `state=PENDING`, `source=AGENT`; the official inventory is never
 * mutated by a machine without human approval (the trust call, §1/§8). This surfaces those proposals
 * at the top of the Servers (Table) view with two actions per row:
 *
 *  - **Confirm** → {@link ConfirmNodeDialog} (`POST /infra/nodes/:id/confirm`): flips to CONFIRMED and,
 *    by default, mints a tracked Asset.
 *  - **Discard** → {@link DeleteNodeDialog}. ponytail: discard = the existing soft-delete
 *    (`DELETE /infra/nodes/:id`), NO new endpoint — a discarded proposal is restorable, history kept.
 *
 * Gated on `infra:manage`: the tray is an ACTION surface, and both actions require manage server-side
 * (confirm additionally needs `asset:write` when tracking), so a read-only viewer sees nothing here.
 * Renders nothing while loading or when there is nothing pending — no empty-tray noise. Uses its own
 * `state=PENDING` query, independent of the table's filters, so it stays visible regardless of them.
 */
export function PendingReviewTray() {
  const t = useTranslations("infra.pending");
  const tInfra = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const { data, isLoading } = useInfraNodes({ state: "PENDING" });
  const deleteNode = useDeleteInfraNode();

  const [confirmTarget, setConfirmTarget] = useState<InfraNodeListItem | null>(
    null,
  );
  const [discardTarget, setDiscardTarget] = useState<InfraNodeListItem | null>(
    null,
  );

  const pending = data ?? [];
  if (!canManage || isLoading || pending.length === 0) return null;

  return (
    <section
      className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-4"
      aria-label={t("title")}
    >
      <div className="flex items-start gap-2">
        <InboxArrowDownIcon
          className="mt-0.5 size-5 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <Badge variant="secondary">{pending.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <ul className="divide-y rounded-md border bg-card">
        {pending.map((node) => (
          <li
            key={node.id}
            className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {node.label}
                </span>
                <Badge variant="outline">{tInfra(`kind.${node.kind}`)}</Badge>
                <AgentBadge />
              </div>
              <AgentFreshness
                reportingSource={node.reportingSource}
                lastReportedAt={node.lastReportedAt}
                status={node.status}
              />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => setConfirmTarget(node)}>
                <CheckIcon />
                {t("confirmAction")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setDiscardTarget(node)}
              >
                <TrashIcon />
                {t("discardAction")}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {confirmTarget ? (
        <ConfirmNodeDialog
          key={confirmTarget.id}
          open
          onOpenChange={(open) => !open && setConfirmTarget(null)}
          node={confirmTarget}
        />
      ) : null}

      {discardTarget ? (
        <DeleteNodeDialog
          open
          onOpenChange={(open) => !open && setDiscardTarget(null)}
          label={discardTarget.label}
          onConfirm={() => deleteNode.mutateAsync(discardTarget.id)}
        />
      ) : null}
    </section>
  );
}
