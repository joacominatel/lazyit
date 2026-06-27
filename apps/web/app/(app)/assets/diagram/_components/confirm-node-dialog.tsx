"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  type ConfirmInfraNode,
  type InfraNodeKind,
  InfraNodeKindSchema,
  type InfraNodeListItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfirmInfraNode } from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";

const KIND_OPTIONS = InfraNodeKindSchema.options;

interface ConfirmNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The PENDING agent-reported node being reviewed. */
  node: InfraNodeListItem;
}

/**
 * Confirm a PENDING agent-reported node from the review tray (ADR-0074 §3). A small form over the
 * `POST /infra/nodes/:id/confirm` body: a `trackAsAsset` toggle (default ON — also mint a tracked
 * Asset), plus optional `kind`/`label` overrides so the operator can re-classify/rename at the gate
 * (the agent lands every host as a `PHYSICAL_HOST` named after its hostname). On success the node
 * leaves the tray (it is now CONFIRMED) via the hook's `infraKeys.all` invalidation.
 *
 * ponytail: no zod resolver — `ConfirmInfraNodeSchema` is a `strictObject` and the API is the real
 * authority; we send only the keys that DIFFER from the node's current kind/label (a bare confirm is
 * `{ trackAsAsset }`). The form remounts per node via the parent's `key`, so it never shows stale drafts.
 */
export function ConfirmNodeDialog({
  open,
  onOpenChange,
  node,
}: ConfirmNodeDialogProps) {
  const t = useTranslations("infra.confirm");
  const tInfra = useTranslations("infra");
  const tc = useTranslations("common");
  const confirm = useConfirmInfraNode();

  const [trackAsAsset, setTrackAsAsset] = useState(true);
  const [kind, setKind] = useState<InfraNodeKind>(node.kind);
  const [label, setLabel] = useState(node.label);

  function handleConfirm() {
    const trimmed = label.trim();
    const body: ConfirmInfraNode = {
      trackAsAsset,
      ...(kind !== node.kind ? { kind } : {}),
      ...(trimmed && trimmed !== node.label ? { label: trimmed } : {}),
    };
    confirm.mutate(
      { id: node.id, body },
      {
        onSuccess: () => {
          toast.success(t("confirmedToast"));
          onOpenChange(false);
        },
        onError: (error) => notifyError(error, t("error")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="confirm-label">{t("labelLabel")}</FieldLabel>
            <Input
              id="confirm-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={confirm.isPending}
              maxLength={200}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="confirm-kind">{t("kindLabel")}</FieldLabel>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as InfraNodeKind)}
            >
              <SelectTrigger
                id="confirm-kind"
                className="w-full"
                disabled={confirm.isPending}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {tInfra(`kind.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor="confirm-track-asset">
                {t("trackAsAssetLabel")}
              </FieldLabel>
              <Switch
                id="confirm-track-asset"
                checked={trackAsAsset}
                onCheckedChange={setTrackAsAsset}
                disabled={confirm.isPending}
              />
            </div>
            <FieldDescription>{t("trackAsAssetDescription")}</FieldDescription>
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
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
