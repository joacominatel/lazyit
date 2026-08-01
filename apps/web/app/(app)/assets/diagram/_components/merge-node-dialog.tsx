"use client";

import { ArrowPathIcon, SparklesIcon } from "@heroicons/react/24/outline";
import type { InfraNodeListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  useInfraIdentityMatches,
  useInfraNodes,
  useMergeInfraNode,
} from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";

interface MergeNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The DUPLICATE — the node whose reporting key is transplanted, and which is then archived. */
  node: InfraNodeListItem;
}

/**
 * Re-key a duplicate into the node it really is (ADR-0074 §3 amendment / #1141) — the human half of
 * identity reconciliation, and the only thing in this change that mutates anything on its own.
 *
 * It closes the two failures the report path can only warn about. A RE-IMAGED host mints a fresh
 * `/etc/machine-id`, so it arrives as a brand-new proposal while the node the operator curated — asset
 * link, owners, position, edges, KB links — drifts OFFLINE forever with nothing connecting the two. A
 * CLONED template lands its second host beside the first. Both are the same fix: move the reporting
 * key onto the node that should keep receiving reports, and archive this one.
 *
 * The suggestions at the top are the payoff of contract v2's `host.identifiers[]`: a node that shares
 * this one's burned-in serial or MAC is almost certainly the same physical box. They are a HINT, never
 * a default — nothing is preselected, because a wrong merge archives a curated node, and the operator
 * is the one who knows whether that box was re-imaged. The picker below lists every other live node,
 * so an estate whose agents predate v2 (no evidence stored, so no suggestions) can still merge.
 */
export function MergeNodeDialog({
  open,
  onOpenChange,
  node,
}: MergeNodeDialogProps) {
  const t = useTranslations("infra.merge");
  const tc = useTranslations("common");
  const merge = useMergeInfraNode();
  // Only fetched while the dialog is open — the containment scan is not worth paying for a closed one.
  const { data: matches } = useInfraIdentityMatches(node.id, open);
  const { data: nodes } = useInfraNodes();

  const [targetNodeId, setTargetNodeId] = useState<string>("");

  const candidates = (nodes ?? []).filter((n) => n.id !== node.id);
  const suggestions = matches ?? [];

  function handleMerge() {
    if (!targetNodeId) return;
    merge.mutate(
      { id: node.id, targetNodeId },
      {
        onSuccess: () => {
          toast.success(t("mergedToast"));
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
          <DialogTitle>{t("title", { label: node.label })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {suggestions.length > 0 ? (
            <Field>
              <FieldLabel>{t("suggestionsLabel")}</FieldLabel>
              <ul className="space-y-2">
                {suggestions.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      onClick={() => setTargetNodeId(match.id)}
                      className={`flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors hover:bg-accent ${
                        targetNodeId === match.id
                          ? "border-primary bg-accent"
                          : ""
                      }`}
                    >
                      <SparklesIcon
                        className="size-4 shrink-0 text-warning"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {t("suggestion", { label: match.label })}
                      </span>
                      <Badge variant="outline">
                        {t(`matchedOn.${match.matchedOn}`)}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
              <FieldDescription>{t("suggestionsDescription")}</FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="merge-target">{t("targetLabel")}</FieldLabel>
            <Select value={targetNodeId} onValueChange={setTargetNodeId}>
              <SelectTrigger
                id="merge-target"
                className="w-full"
                disabled={merge.isPending}
              >
                <SelectValue placeholder={t("targetPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t("targetDescription")}</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={merge.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleMerge}
            disabled={merge.isPending || !targetNodeId}
          >
            {merge.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
