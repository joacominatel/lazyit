"use client";

import { ArrowPathIcon, LinkIcon } from "@heroicons/react/24/outline";
import {
  type ConfirmInfraNode,
  type InfraAssetCandidate,
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
import {
  useConfirmInfraNode,
  useInfraNodeDetail,
} from "@/lib/api/hooks/use-infra-nodes";
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
 *
 * **Adoption foresight (ADR-0093 §7).** Since the confirm gate learned to ADOPT an existing Asset
 * whose serial this report corroborates, rather than mint a second one, "track as an asset" no longer
 * means one thing — and the operator has to know which before they click, not after. So the dialog
 * fetches the node's detail purely to read `assetCandidate` and, when the server names one, says so:
 * *this will link Dell-XPS-7490*, with the serial it matched on. This is the entire reason that read
 * field exists; a confirm that silently attaches a machine to a row somebody curated is precisely the
 * surprise it was added to prevent.
 *
 * The detail read is display-only and never a gate. `trackAsAsset` stays a plain boolean on a
 * `strictObject` — adoption is HOW `true` is satisfied, chosen server-side from evidence, not a third
 * thing this form asks for — so the confirm re-derives its own answer at the moment it runs. A
 * candidate that is stale, absent, or still in flight can therefore only ever under-inform a human;
 * it can never mis-link a machine. That is why the copy falls back to today's "will create" wording
 * rather than blocking on the fetch.
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
  // Read only while the dialog is open: the tray mounts this per target (`key={target.id}`), so the
  // fetch is bounded to the one node the operator is actually deciding about.
  const { data: detail } = useInfraNodeDetail(open ? node.id : null);
  const candidate = detail?.assetCandidate ?? null;

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
            {/* Foresight, not a surprise (ADR-0093 §7). Shown only while the toggle is ON, because
                with it off no Asset is touched at all and naming one would be a promise about
                something that will not happen. */}
            {trackAsAsset && candidate ? (
              <AdoptionNotice candidate={candidate} />
            ) : null}
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

/**
 * *"Confirming will link an asset you already have"* (ADR-0093 §7) — the display-only heads-up that
 * turns an invisible server-side choice into one the operator saw coming.
 *
 * It names the Asset and the **serial the server matched on**, because the serial is the entire basis
 * for the match: a name alone asks the operator to trust a link they cannot check, and the whole
 * point of adopting rather than duplicating is that the machine in front of them is provably the one
 * already in inventory. The `info` tone, not `warning` — nothing is wrong here. This is the good
 * outcome, and the alternative it replaces (a second, serial-less Asset for one physical machine) is
 * the one worth warning about.
 */
function AdoptionNotice({ candidate }: { candidate: InfraAssetCandidate }) {
  const t = useTranslations("infra.confirm");
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-xs">
      <LinkIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p>{t("adoptExisting")}</p>
        <p className="truncate font-medium text-foreground" title={candidate.name}>
          {candidate.name}
        </p>
        {candidate.serial ? (
          <p className="text-muted-foreground">
            {t("adoptSerial")}{" "}
            <span className="font-mono">{candidate.serial}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
