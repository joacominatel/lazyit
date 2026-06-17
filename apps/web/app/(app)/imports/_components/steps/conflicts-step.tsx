"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type {
  ConflictOutcome,
  ImportDryRunReport,
  ImportResolutionPlan,
  ReferenceConflict,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCommitImport,
  useSaveImportPlan,
} from "@/lib/api/hooks/use-imports";
import { cn } from "@/lib/utils";
import { useImportError } from "../use-import-error";

/** Stable per-conflict key — the distinct `(entity, field, normalizedValue)` tuple (ADR-0069 §6). */
function conflictKey(c: ReferenceConflict): string {
  return `${c.entity}::${c.field}::${c.normalizedValue}`;
}

/** A local in-progress resolution: the chosen outcome + (for match/restore) the chosen candidate id. */
interface Resolution {
  outcome: ConflictOutcome;
  targetId: string | null;
}

/**
 * Step 5 — Conflict resolution (ADR-0069 §6). For each DISTINCT reference conflict the dry-run found,
 * the operator picks one of four outcomes — **match** (link a live record), **restore** (un-archive a
 * ghost), **create** (only when no live match), **skip** (import the rows without the link). We NEVER
 * auto-pick an ambiguous candidate: when the engine flagged `ambiguous` (or for any match/restore)
 * the operator must choose the specific record. The blast radius (row count + sample rows) is shown so
 * the impact of each choice is visible. On submit we freeze the plan (`POST plan` → DRY_RUN) and
 * immediately enqueue the commit (`POST commit` → 202), handing control to the commit step.
 */
export function ConflictsStep({
  sessionId,
  report,
  onBack,
  onPlanned,
}: {
  sessionId: string;
  report: ImportDryRunReport;
  onBack: () => void;
  onPlanned: () => void;
}) {
  const t = useTranslations("imports");
  const { notify } = useImportError();
  const savePlan = useSaveImportPlan();
  const commit = useCommitImport();

  const conflicts = report.conflicts;

  // Seed each conflict with the engine's suggestion — but only auto-apply it when it is unambiguous
  // (a single candidate, or a plain create). Ambiguous conflicts start unresolved so the operator
  // must choose (no auto-pick, ADR-0069 §5/§6).
  const initial = useMemo<Record<string, Resolution>>(() => {
    const out: Record<string, Resolution> = {};
    for (const c of conflicts) {
      const liveCandidates = c.candidates.filter((cand) => cand.live);
      const onlyCandidateId =
        c.candidates.length === 1 ? c.candidates[0].id : null;
      if (!c.ambiguous && c.suggested === "create") {
        out[conflictKey(c)] = { outcome: "create", targetId: null };
      } else if (!c.ambiguous && (c.suggested === "match" || c.suggested === "restore")) {
        out[conflictKey(c)] = {
          outcome: c.suggested,
          targetId: onlyCandidateId,
        };
      } else {
        // Ambiguous → leave the outcome chosen but the target empty so the gate forces a pick.
        out[conflictKey(c)] = {
          outcome: liveCandidates.length > 0 ? "match" : "create",
          targetId: null,
        };
      }
    }
    return out;
  }, [conflicts]);

  const [resolutions, setResolutions] = useState(initial);

  function setResolution(key: string, patch: Partial<Resolution>) {
    setResolutions((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  const isBusy = savePlan.isPending || commit.isPending;

  // The gate: every conflict resolved, and every match/restore has a chosen candidate.
  const unresolvedCount = conflicts.filter((c) => {
    const r = resolutions[conflictKey(c)];
    if (!r) return true;
    if ((r.outcome === "match" || r.outcome === "restore") && !r.targetId) return true;
    return false;
  }).length;

  function buildPlan(): ImportResolutionPlan {
    return {
      conflicts: conflicts.map((c) => {
        const r = resolutions[conflictKey(c)];
        return {
          entity: c.entity,
          field: c.field,
          normalizedValue: c.normalizedValue,
          outcome: r.outcome,
          targetId: r.outcome === "match" || r.outcome === "restore" ? r.targetId : null,
        };
      }),
    };
  }

  function handleSubmit() {
    if (unresolvedCount > 0) return;
    savePlan.mutate(
      { id: sessionId, plan: buildPlan() },
      {
        onSuccess: () => {
          commit.mutate(sessionId, {
            onSuccess: () => onPlanned(),
            onError: (error) => notify(error, "commit"),
          });
        },
        onError: (error) => notify(error, "plan"),
      },
    );
  }

  if (conflicts.length === 0) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{t("conflicts.none")}</p>
        <div className="flex justify-between">
          <Button type="button" variant="outline" onClick={onBack} disabled={isBusy}>
            {t("common.back")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isBusy}>
            {isBusy && <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />}
            {isBusy ? t("conflicts.saving") : t("conflicts.submit")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("conflicts.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("conflicts.description")}</p>
      </div>

      <ul className="space-y-4">
        {conflicts.map((c) => {
          const key = conflictKey(c);
          const r = resolutions[key];
          const liveCandidates = c.candidates.filter((cand) => cand.live);
          const ghostCandidates = c.candidates.filter((cand) => !cand.live);
          const outcomeId = `outcome-${key}`;
          const candidateId = `candidate-${key}`;
          const needsCandidate = r?.outcome === "match" || r?.outcome === "restore";
          const candidatePool = r?.outcome === "restore" ? ghostCandidates : liveCandidates;
          const hasLive = liveCandidates.length > 0;

          return (
            <li key={key} className="space-y-3 rounded-lg border p-4">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  {t("conflicts.entityField", { entity: c.entity, field: c.field })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("conflicts.value", { value: c.normalizedValue })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("conflicts.blastRadius", { count: c.rowCount })}
                  {c.sampleRowIndexes.length > 0 && (
                    <>
                      {" · "}
                      {t("conflicts.sampleRows", {
                        rows: c.sampleRowIndexes.join(", "),
                      })}
                    </>
                  )}
                </p>
                {c.ambiguous && (
                  <p className="text-xs font-medium text-warning">
                    {t("conflicts.ambiguous")}
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={outcomeId}>{t("conflicts.outcomeLabel")}</Label>
                  <Select
                    value={r?.outcome}
                    onValueChange={(value) =>
                      setResolution(key, { outcome: value as ConflictOutcome, targetId: null })
                    }
                  >
                    <SelectTrigger id={outcomeId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {hasLive && (
                        <SelectItem value="match">{t("conflicts.outcome.match")}</SelectItem>
                      )}
                      {ghostCandidates.length > 0 && (
                        <SelectItem value="restore">{t("conflicts.outcome.restore")}</SelectItem>
                      )}
                      {/* create is only valid when no live match exists (ADR-0069 §6). */}
                      {!hasLive && (
                        <SelectItem value="create">{t("conflicts.outcome.create")}</SelectItem>
                      )}
                      <SelectItem value="skip">{t("conflicts.outcome.skip")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {needsCandidate && candidatePool.length > 0 && (
                  <div className="space-y-1">
                    <Label htmlFor={candidateId}>{t("conflicts.chooseCandidate")}</Label>
                    <Select
                      value={r?.targetId ?? undefined}
                      onValueChange={(value) => setResolution(key, { targetId: value })}
                    >
                      <SelectTrigger
                        id={candidateId}
                        className={cn("w-full", !r?.targetId && "border-warning")}
                      >
                        <SelectValue placeholder={t("conflicts.chooseCandidate")} />
                      </SelectTrigger>
                      <SelectContent>
                        {candidatePool.map((cand) => (
                          <SelectItem key={cand.id} value={cand.id}>
                            {cand.label}
                            {cand.categoryName
                              ? ` · ${t("conflicts.candidateCategory", { category: cand.categoryName })}`
                              : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {!hasLive && r?.outcome === "create" && (
                <p className="text-xs text-muted-foreground">{t("conflicts.createNote")}</p>
              )}
              {r?.outcome === "skip" && (
                <p className="text-xs text-muted-foreground">{t("conflicts.skipNote")}</p>
              )}
            </li>
          );
        })}
      </ul>

      {unresolvedCount > 0 && (
        <p className="text-sm text-destructive" role="alert">
          {t("conflicts.unresolved", { count: unresolvedCount })}
        </p>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack} disabled={isBusy}>
          {t("common.back")}
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={isBusy || unresolvedCount > 0}
        >
          {isBusy && <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />}
          {isBusy ? t("conflicts.saving") : t("conflicts.submit")}
        </Button>
      </div>
    </div>
  );
}
