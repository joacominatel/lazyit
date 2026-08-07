"use client";

import { ArrowPathIcon, SparklesIcon } from "@heroicons/react/24/outline";
import type { InfraNodeListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/combobox";
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
 * is the one who knows whether that box was re-imaged. The picker below reaches every other live node
 * by search, so an estate whose agents predate v2 (no evidence stored, so no suggestions) can still
 * merge — at any estate size, since #1152 made it a server-search picker rather than a `<Select>` of
 * whatever nodes happened to be loaded.
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

  const [targetNodeId, setTargetNodeId] = useState<string>("");
  const [query, setQuery] = useState("");
  // The chosen target's label, remembered at pick time so the trigger keeps naming it after the
  // operator types again (a suggestion click sets it too — see the buttons above).
  const [targetLabel, setTargetLabel] = useState<string>("");

  // The candidate picker is a SERVER-SEARCH page (#1152), not the whole node list: this dialog used
  // to render one `<SelectItem>` per live node, which on a paged endpoint would have made any node
  // past the first window unmergeable — and "unmergeable" here means a curated host left to drift
  // OFFLINE forever beside its re-imaged twin. ADR-0030 §8 (#199/#218) removed exactly this ceiling
  // from the KB asset picker; this is the same move.
  const { data: page, isFetching } = useInfraNodes(
    { q: query || undefined, limit: 50 },
    { enabled: open },
  );

  // The node being merged is never a candidate — the API 400s a self-merge, and offering it is a
  // dead end the operator should not have to discover.
  const candidateItems = useMemo(
    () =>
      (page?.items ?? [])
        .filter((n) => n.id !== node.id)
        .map((n) => ({ value: n.id, label: n.label })),
    [page?.items, node.id],
  );
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
                      onClick={() => {
                        setTargetNodeId(match.id);
                        setTargetLabel(match.label);
                      }}
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
            <Combobox
              id="merge-target"
              value={targetNodeId}
              onValueChange={(value) => {
                setTargetLabel(
                  candidateItems.find((item) => item.value === value)?.label ?? "",
                );
                setTargetNodeId(value);
              }}
              items={candidateItems}
              onSearchChange={setQuery}
              loading={isFetching}
              selectedLabel={targetLabel || undefined}
              disabled={merge.isPending}
              placeholder={t("targetPlaceholder")}
              searchPlaceholder={t("targetSearch")}
              emptyText={t("targetEmpty")}
              loadingText={tc("searching")}
            />
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
