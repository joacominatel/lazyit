"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  defaultTrackAsAsset,
  InfraNodeKindSchema,
  statesAutoConfirmCondition,
  type CreateInfraAutoConfirmRule,
  type InfraAutoConfirmScope,
  type InfraNodeKind,
} from "@lazyit/shared";
import { useFormatter, useTranslations } from "next-intl";
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
  useCreateInfraAutoConfirmRule,
  useDeleteInfraAutoConfirmRule,
  useInfraAutoConfirmRules,
  useUpdateInfraAutoConfirmRule,
} from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";

const NO_KIND = "NONE";

interface AutoConfirmRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Manage the operator-authored auto-confirm rules (ADR-0074 §1 amendment, #1145).
 *
 * A rule lets the operator express their judgement ONCE — *"hosts reporting from 10.20.0.0/16 named
 * `srv-*` are VMs, track them"* — instead of once per discovered host. It does NOT reopen §1's
 * rejection of blanket auto-confirm: the rule IS the human decision, it records who wrote it, and
 * disabling or deleting it stops it matching immediately.
 *
 * **Two things this dialog must state plainly, because they are the properties an operator has to
 * trust before writing a rule at all:**
 *
 *  1. **A rule is never retroactive.** It only sees reports that arrive after it is saved, so nothing
 *     already sitting in the review tray confirms behind the operator who is looking at it.
 *  2. **A rule needs a condition that can rule a proposal OUT.** None at all — or one spelled `*` /
 *     `0.0.0.0/0`, which matches every proposal there is — would be blanket auto-confirm, and the API
 *     refuses to store it. Any pattern made only of wildcards is refused on the same footing, `?`
 *     included: it narrows to one-character names rather than matching everything, and is refused
 *     conservatively so the rule stays "the pattern has to carry a literal character". The form uses
 *     the very same `statesAutoConfirmCondition` the contract does, so it says so before the 400 does.
 *
 * It lives here, on the tray, rather than in Settings: this is where an operator feels the cost that
 * makes a rule worth writing, and a rule written anywhere else is a setting nobody finds.
 */
export function AutoConfirmRulesDialog({
  open,
  onOpenChange,
}: AutoConfirmRulesDialogProps) {
  const t = useTranslations("infra.rules");
  const tInfra = useTranslations("infra");
  const tc = useTranslations("common");
  const format = useFormatter();

  const { data: rules, isLoading } = useInfraAutoConfirmRules(open);
  const createRule = useCreateInfraAutoConfirmRule();
  const updateRule = useUpdateInfraAutoConfirmRule();
  const deleteRule = useDeleteInfraAutoConfirmRule();

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [appliesTo, setAppliesTo] = useState<InfraAutoConfirmScope>("HOST");
  const [hostnamePattern, setHostnamePattern] = useState("");
  const [subnetCidr, setSubnetCidr] = useState("");
  const [reportedKind, setReportedKind] = useState<InfraNodeKind | typeof NO_KIND>(NO_KIND);
  const [confirmAsKind, setConfirmAsKind] = useState<InfraNodeKind | typeof NO_KIND>(NO_KIND);
  const [trackAsAsset, setTrackAsAsset] = useState(defaultTrackAsAsset(false));

  function resetForm() {
    setAdding(false);
    setName("");
    setAppliesTo("HOST");
    setHostnamePattern("");
    setSubnetCidr("");
    setReportedKind(NO_KIND);
    setConfirmAsKind(NO_KIND);
    setTrackAsAsset(defaultTrackAsAsset(false));
  }

  /**
   * Keep the container default (OFF) in step with the scope the operator picked — for `ANY` as well
   * as `CONTAINER`, because an `ANY` rule reaches container children too and the server defaults it
   * the same way. The switch stays right there for the operator who wants otherwise.
   */
  function pickScope(scope: InfraAutoConfirmScope) {
    setAppliesTo(scope);
    setTrackAsAsset(defaultTrackAsAsset(scope !== "HOST"));
  }

  // The SAME predicate the create contract and the matcher use, so the form refuses exactly what the
  // API would: a wildcard-only pattern or `0.0.0.0/0` is not a condition. Most wildcard-only patterns
  // (`*`, `**`, `*?*`) exclude nothing at all; `?` alone does narrow — to one-character names — and is
  // refused with them conservatively, because "carries a literal" is the line an operator can see.
  const hasCondition = statesAutoConfirmCondition({
    hostnamePattern: hostnamePattern.trim() || null,
    subnetCidr: subnetCidr.trim() || null,
    reportedKind: reportedKind === NO_KIND ? null : reportedKind,
  });

  function handleSave() {
    const body: CreateInfraAutoConfirmRule = {
      name: name.trim(),
      appliesTo,
      trackAsAsset,
      ...(hostnamePattern.trim() ? { hostnamePattern: hostnamePattern.trim() } : {}),
      ...(subnetCidr.trim() ? { subnetCidr: subnetCidr.trim() } : {}),
      ...(reportedKind !== NO_KIND ? { reportedKind } : {}),
      ...(confirmAsKind !== NO_KIND ? { confirmAsKind } : {}),
    };
    createRule.mutate(body, {
      onSuccess: () => {
        toast.success(t("savedToast"));
        resetForm();
      },
      onError: (error) => notifyError(error, t("saveError")),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {/* The non-retroactivity promise, stated where the decision is made — not only in the Manual. */}
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
          <ExclamationTriangleIcon
            className="mt-0.5 size-4 shrink-0 text-warning"
            aria-hidden
          />
          <span>{t("notRetroactive")}</span>
        </p>

        <div className="max-h-72 space-y-2 overflow-y-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{tc("loading")}</p>
          ) : null}
          {!isLoading && (rules?.length ?? 0) === 0 ? (
            <p className="rounded-md border p-3 text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : null}
          {(rules ?? []).map((rule, index) => (
            <div
              key={rule.id}
              className="flex flex-wrap items-center gap-2 rounded-md border p-3"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* The evaluation order is load-bearing (first match wins), so it is shown. */}
                  <Badge variant="secondary">{index + 1}</Badge>
                  <span className="truncate text-sm font-medium">{rule.name}</span>
                  <Badge variant="outline">{t(`scope.${rule.appliesTo}`)}</Badge>
                  {rule.trackAsAsset ? (
                    <Badge variant="outline">{t("tracksAsset")}</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {[
                    rule.hostnamePattern
                      ? t("conditionHostname", { pattern: rule.hostnamePattern })
                      : null,
                    rule.subnetCidr
                      ? t("conditionSubnet", { cidr: rule.subnetCidr })
                      : null,
                    rule.reportedKind
                      ? t("conditionKind", { kind: tInfra(`kind.${rule.reportedKind}`) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {/* Attribution and effect, side by side: WHO authored this decision and what it has
                      actually done. A rule that confirms hosts with no human present has to be legible. */}
                  {rule.createdByName
                    ? t("author", { name: rule.createdByName })
                    : t("authorUnknown")}
                  {" · "}
                  {rule.lastMatchedAt
                    ? t("lastMatched", {
                        count: rule.matchCount,
                        when: format.dateTime(new Date(rule.lastMatchedAt), {
                          dateStyle: "medium",
                        }),
                      })
                    : t("neverMatched")}
                </p>
              </div>
              <Switch
                checked={rule.enabled}
                aria-label={t("enabledLabel")}
                disabled={updateRule.isPending}
                onCheckedChange={(next) =>
                  updateRule.mutate(
                    { id: rule.id, patch: { enabled: next } },
                    { onError: (error) => notifyError(error, t("saveError")) },
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                aria-label={t("deleteLabel")}
                disabled={deleteRule.isPending}
                onClick={() =>
                  deleteRule.mutate(rule.id, {
                    onSuccess: () => toast.success(t("deletedToast")),
                    onError: (error) => notifyError(error, t("deleteError")),
                  })
                }
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
        </div>

        {adding ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="rule-name">{t("nameLabel")}</FieldLabel>
              <Input
                id="rule-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("namePlaceholder")}
                maxLength={120}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-scope">{t("scopeLabel")}</FieldLabel>
              <Select
                value={appliesTo}
                onValueChange={(value) => pickScope(value as InfraAutoConfirmScope)}
              >
                <SelectTrigger id="rule-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HOST">{t("scope.HOST")}</SelectItem>
                  <SelectItem value="CONTAINER">{t("scope.CONTAINER")}</SelectItem>
                  <SelectItem value="ANY">{t("scope.ANY")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-hostname">{t("hostnameLabel")}</FieldLabel>
              <Input
                id="rule-hostname"
                value={hostnamePattern}
                onChange={(event) => setHostnamePattern(event.target.value)}
                placeholder="srv-*"
              />
              <FieldDescription>{t("hostnameDescription")}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-subnet">{t("subnetLabel")}</FieldLabel>
              <Input
                id="rule-subnet"
                value={subnetCidr}
                onChange={(event) => setSubnetCidr(event.target.value)}
                placeholder="10.20.0.0/16"
              />
              <FieldDescription>{t("subnetDescription")}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-reported-kind">
                {t("reportedKindLabel")}
              </FieldLabel>
              <Select
                value={reportedKind}
                onValueChange={(value) =>
                  setReportedKind(value as InfraNodeKind | typeof NO_KIND)
                }
              >
                <SelectTrigger id="rule-reported-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_KIND}>{t("anyKind")}</SelectItem>
                  {InfraNodeKindSchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {tInfra(`kind.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t("reportedKindDescription")}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-confirm-kind">
                {t("confirmAsKindLabel")}
              </FieldLabel>
              <Select
                value={confirmAsKind}
                onValueChange={(value) =>
                  setConfirmAsKind(value as InfraNodeKind | typeof NO_KIND)
                }
              >
                <SelectTrigger id="rule-confirm-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_KIND}>{t("keepProposedKind")}</SelectItem>
                  {InfraNodeKindSchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {tInfra(`kind.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="rule-track">{t("trackAsAssetLabel")}</FieldLabel>
                <Switch
                  id="rule-track"
                  checked={trackAsAsset}
                  onCheckedChange={setTrackAsAsset}
                />
              </div>
              <FieldDescription>{t("trackAsAssetDescription")}</FieldDescription>
            </Field>

            {!hasCondition ? (
              <p className="text-xs text-destructive">{t("needsCondition")}</p>
            ) : null}
          </FieldGroup>
        ) : null}

        <DialogFooter>
          {adding ? (
            <>
              <Button type="button" variant="outline" onClick={resetForm}>
                {tc("cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={!hasCondition || name.trim() === "" || createRule.isPending}
              >
                {createRule.isPending && <ArrowPathIcon className="animate-spin" />}
                {t("saveSubmit")}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tc("close")}
              </Button>
              <Button type="button" onClick={() => setAdding(true)}>
                <PlusIcon />
                {t("addAction")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
