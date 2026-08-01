"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  defaultTrackAsAsset,
  InfraNodeKindSchema,
  isContainerChildExternalId,
  type BulkConfirmInfraNodeItem,
  type InfraBulkResponse,
  type InfraNodeKind,
  type InfraNodeListItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useBulkConfirmInfraNodes,
  useBulkDiscardInfraNodes,
} from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";

interface BulkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected PENDING proposals, hosts and container children together. */
  nodes: InfraNodeListItem[];
  /** Called after a batch is applied, so the tray can clear its selection. */
  onDone: () => void;
}

/** Split a selection into reporting hosts and container children — they get different defaults. */
function split(nodes: InfraNodeListItem[]) {
  const containers = nodes.filter((node) =>
    isContainerChildExternalId(node.externalId),
  );
  const hosts = nodes.filter(
    (node) => !isContainerChildExternalId(node.externalId),
  );
  return { hosts, containers };
}

/**
 * Turn a bulk response into ONE sentence the operator can act on. The API answers per item, so a
 * batch can land partially — reporting only "done" would hide exactly the rows that need attention,
 * and reporting only a failure would hide the thirty-nine that worked.
 */
function summarize(
  result: InfraBulkResponse,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): void {
  if (result.failed === 0 && result.notFound === 0) {
    toast.success(t("appliedToast", { count: result.applied }));
    return;
  }
  toast.warning(
    t("partialToast", {
      applied: result.applied,
      failed: result.failed + result.notFound,
    }),
  );
  // Name the first failure. The response carries each row's label precisely so a partial batch can be
  // reported by NAME rather than as an anonymous count.
  const firstFailure = result.results.find((item) => item.outcome === "failed");
  if (firstFailure) {
    toast.error(
      t("failureDetail", {
        label: firstFailure.label ?? firstFailure.id,
        message: firstFailure.message ?? "",
      }),
    );
  }
}

/**
 * Confirm a whole selection at once (ADR-0074 §1 amendment, #1145).
 *
 * The gate is not weakened: this is the SAME confirm, run once per selected node with the same
 * optional overrides, batched into one request. A human still approves every node — just not one
 * dialog at a time, which is what a Docker host reporting thirty containers had made the tray cost.
 *
 * **`trackAsAsset` is split by scope, and that is the deliberate part.** The single confirm defaults
 * it ON, which is right for a discovered SERVER — a thing the operator owns, assigns and warranties.
 * A container is not that thing: `docker compose up --force-recreate` replaces it, it has no serial to
 * promote, and defaulting a bulk confirm ON would mint an Asset per container that nobody will ever
 * curate. So hosts default ON and children default OFF (`defaultTrackAsAsset`), both switchable here.
 *
 * The kind override is optional and applies to the whole batch, because it is a CLASSIFICATION the
 * operator is correcting ("these are all VMs"). `label` is deliberately not offered: renaming forty
 * nodes to one string is never what anyone meant, so it stays on the single confirm.
 */
export function BulkConfirmDialog({
  open,
  onOpenChange,
  nodes,
  onDone,
}: BulkDialogProps) {
  const t = useTranslations("infra.bulk");
  const tInfra = useTranslations("infra");
  const tc = useTranslations("common");
  const confirm = useBulkConfirmInfraNodes();

  const { hosts, containers } = useMemo(() => split(nodes), [nodes]);
  const [trackHosts, setTrackHosts] = useState(defaultTrackAsAsset(false));
  const [trackContainers, setTrackContainers] = useState(defaultTrackAsAsset(true));
  const [kind, setKind] = useState<InfraNodeKind | "KEEP">("KEEP");

  function handleConfirm() {
    const items: BulkConfirmInfraNodeItem[] = nodes.map((node) => ({
      id: node.id,
      trackAsAsset: isContainerChildExternalId(node.externalId)
        ? trackContainers
        : trackHosts,
      // Only send a kind when the operator asked to re-classify — a bare confirm leaves the kind the
      // server proposed (#1139) exactly as the single confirm does.
      ...(kind !== "KEEP" && kind !== node.kind ? { kind } : {}),
    }));
    confirm.mutate(
      { items },
      {
        onSuccess: (result) => {
          summarize(result, t);
          onDone();
          onOpenChange(false);
        },
        onError: (error) => notifyError(error, t("confirmError")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("confirmTitle", { count: nodes.length })}</DialogTitle>
          <DialogDescription>
            {t("confirmDescription", {
              hosts: hosts.length,
              containers: containers.length,
            })}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {hosts.length > 0 ? (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="bulk-track-hosts">
                  {t("trackHostsLabel", { count: hosts.length })}
                </FieldLabel>
                <Switch
                  id="bulk-track-hosts"
                  checked={trackHosts}
                  onCheckedChange={setTrackHosts}
                  disabled={confirm.isPending}
                />
              </div>
              <FieldDescription>{t("trackHostsDescription")}</FieldDescription>
            </Field>
          ) : null}

          {containers.length > 0 ? (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="bulk-track-containers">
                  {t("trackContainersLabel", { count: containers.length })}
                </FieldLabel>
                <Switch
                  id="bulk-track-containers"
                  checked={trackContainers}
                  onCheckedChange={setTrackContainers}
                  disabled={confirm.isPending}
                />
              </div>
              <FieldDescription>{t("trackContainersDescription")}</FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="bulk-kind">{t("kindLabel")}</FieldLabel>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as InfraNodeKind | "KEEP")}
            >
              <SelectTrigger
                id="bulk-kind"
                className="w-full"
                disabled={confirm.isPending}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="KEEP">{t("kindKeep")}</SelectItem>
                {InfraNodeKindSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {tInfra(`kind.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t("kindDescription")}</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirm.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={confirm.isPending}>
            {confirm.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("confirmSubmit", { count: nodes.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Discard a whole selection at once. Discard is still the EXISTING soft delete (ADR-0074 §3 builds no
 * reject endpoint), so a discarded proposal is restorable and its history is kept — which is exactly
 * what makes a bulk discard a safe action to offer, and what the copy says.
 */
export function BulkDiscardDialog({
  open,
  onOpenChange,
  nodes,
  onDone,
}: BulkDialogProps) {
  const t = useTranslations("infra.bulk");
  const tc = useTranslations("common");
  const discard = useBulkDiscardInfraNodes();

  function handleDiscard() {
    discard.mutate(
      { ids: nodes.map((node) => node.id) },
      {
        onSuccess: (result) => {
          summarize(result, t);
          onDone();
          onOpenChange(false);
        },
        onError: (error) => notifyError(error, t("discardError")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("discardTitle", { count: nodes.length })}</DialogTitle>
          <DialogDescription>{t("discardDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={discard.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDiscard}
            disabled={discard.isPending}
          >
            {discard.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("discardSubmit", { count: nodes.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
