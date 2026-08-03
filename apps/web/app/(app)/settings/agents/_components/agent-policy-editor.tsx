"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  AGENT_POLICY_DEFAULT,
  AGENT_POLICY_GLOBS_MAX,
  AGENT_POLICY_INTERVAL_MAX_SECONDS,
  AGENT_POLICY_INTERVAL_MIN_SECONDS,
  AGENT_POLICY_SOFTWARE_MAX,
  AGENT_POLICY_STALE_MAX_SECONDS,
  AGENT_POLICY_STALE_MIN_SECONDS,
  AGENT_POLICY_TICK_SECONDS,
  AgentPolicyGlobSchema,
  type AgentPolicyCollect,
  type AgentPolicyOverride,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import {
  useAgentPolicy,
  useSaveAgentPolicy,
} from "@/lib/api/hooks/use-agent-policy";
import { notifyError } from "@/lib/api/notify-error";
import { reseedAction } from "./agent-policy-reseed";

/** The five collectors, in the order the policy schema declares them. */
const COLLECTORS: readonly (keyof AgentPolicyCollect)[] = [
  "hardware",
  "disks",
  "nics",
  "software",
  "containers",
];

/**
 * Each exclusion list and the collector that has to be ON for it to do anything.
 *
 * The pairing is not cosmetic: the agent gates the whole collector BEFORE it applies the list
 * (`applyNicPolicy` / `applyDiskPolicy` return early, `collectSoftware` returns `disabled`), so a
 * glob typed under a collector that is off is stored and honoured by nobody. Saying so at the field
 * beats letting an operator conclude their pattern is broken.
 */
const EXCLUSIONS = [
  { key: "nicNames", collector: "nics" },
  { key: "mountpoints", collector: "disks" },
  { key: "softwareNames", collector: "software" },
] as const satisfies readonly {
  key: keyof AgentPolicyExcludeForm;
  collector: keyof AgentPolicyCollect;
}[];

/** The three glob fields, as the form holds them (comma-separated text, not arrays). */
interface AgentPolicyExcludeForm {
  nicNames: string;
  mountpoints: string;
  softwareNames: string;
}

/** Minutes ↔ seconds, so the operator types the unit they actually think in. */
const MIN_MINUTES = AGENT_POLICY_INTERVAL_MIN_SECONDS / 60;
const MAX_MINUTES = AGENT_POLICY_INTERVAL_MAX_SECONDS / 60;
/**
 * The staleness field has its OWN bounds, and they are not the interval's: the schema floors it at
 * one tick and ceils it at 7 days. Validating only the floor let an operator type a value the API
 * would reject, turning a fixable typo into a failed save with a 400 behind it.
 */
const STALE_MIN_MINUTES = AGENT_POLICY_STALE_MIN_SECONDS / 60;
const STALE_MAX_MINUTES = AGENT_POLICY_STALE_MAX_SECONDS / 60;

/** The editable shape — everything the form holds, flattened out of the nested policy groups. */
interface FormState extends AgentPolicyExcludeForm {
  intervalMinutes: string;
  staleAfterMinutes: string;
  softwareMax: string;
  collect: AgentPolicyCollect;
}

/** Render a glob list as the comma-separated text an operator edits. */
function toText(globs: readonly string[]): string {
  return globs.join(", ");
}

/** Parse comma-separated text back into a glob list (blanks dropped, order preserved). */
function toGlobs(text: string): string[] {
  return text
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/** The first entry that is not a valid glob, or undefined when every entry is fine. */
function firstBadGlob(text: string): string | undefined {
  return toGlobs(text).find((g) => !AgentPolicyGlobSchema.safeParse(g).success);
}

/** A positive integer from a text field, or undefined when it is blank or unusable. */
function intOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Field-by-field equality — the form is flat apart from `collect`, so this stays exhaustive. */
function sameForm(a: FormState, b: FormState): boolean {
  return (
    a.intervalMinutes === b.intervalMinutes &&
    a.staleAfterMinutes === b.staleAfterMinutes &&
    a.softwareMax === b.softwareMax &&
    a.nicNames === b.nicNames &&
    a.mountpoints === b.mountpoints &&
    a.softwareNames === b.softwareNames &&
    COLLECTORS.every((key) => a.collect[key] === b.collect[key])
  );
}

/** Seed the form from what the server actually stores, so the fields can never drift from it. */
function seedFrom(effective: {
  intervalSeconds: number;
  staleAfterSeconds: number;
  softwareMax: number;
  collect: AgentPolicyCollect;
  exclude: { nicNames: string[]; mountpoints: string[]; softwareNames: string[] };
}): FormState {
  return {
    intervalMinutes: String(Math.round(effective.intervalSeconds / 60)),
    staleAfterMinutes: String(Math.round(effective.staleAfterSeconds / 60)),
    softwareMax: String(effective.softwareMax),
    collect: { ...effective.collect },
    nicNames: toText(effective.exclude.nicNames),
    mountpoints: toText(effective.exclude.mountpoints),
    softwareNames: toText(effective.exclude.softwareNames),
  };
}

/**
 * Settings → Reporting agents: the instance-default policy editor (ADR-0074 §7 amendment, #1140;
 * moved out of Settings → Instance and given an information architecture by #1174).
 *
 * This is the surface that replaces SSH-ing to every host to edit the agent's config file. What it
 * saves is the INSTANCE DEFAULT layer; the per-service-account and per-node scopes exist in the API
 * and have no editor in this build, which the scopes panel beside this one states outright.
 *
 * **The three groups are the point of the rewrite.** The fields used to sit in one flat column, so
 * nothing on screen said that the interval and the staleness threshold constrain each other, or that
 * an exclusion list is inert while its collector is off. Both are real domain constraints and both
 * are now rendered next to the field they govern rather than surfacing as a failed save.
 *
 * Two properties the copy has to carry, because they are the difference between a setting an
 * operator trusts and one they are surprised by:
 *
 *  1. **A change takes effect on the next report, not now.** The policy rides the report ack, so a
 *     host picks it up when it next checks in and applies it the run after that. That delay is
 *     deliberate — a bad policy can never brick a fleet mid-collection.
 *  2. **A host's own config file can VETO any of this.** A host whose file turns software collection
 *     off cannot have it turned back on from here. It is not a bug to explain away; it is the honest
 *     posture for a self-hosted product where the host owner and the lazyit admin may be different
 *     people, and it is stated where the switches are.
 *
 * Save is deliberately NEVER disabled on a clean form. A stored layer this build cannot parse
 * resolves as "no override" (`AgentPolicyService.parseOverride`) and the documented remedy is to
 * re-save it from here — which is a no-op as far as the form can tell, and would be unreachable
 * behind a dirty check.
 *
 * A policy write from ANOTHER scope, tab or API client bumps the same revision counter this form
 * re-seeds on, so it used to silently replace an in-progress edit — and now that the action bar
 * carries an "Unsaved changes" badge and a Discard button, it would have cleared those too, leaving
 * the loss looking like an ordinary clean form. {@link reseedAction} holds the edit back in that one
 * case and the page says so, with reloading left as the operator's explicit choice. It does not make
 * the write safe: the PUT still replaces the whole instance layer and the last writer still wins.
 */
export function AgentPolicyEditor() {
  const t = useTranslations("settings.agentPolicy");
  const tc = useTranslations("common");
  const { data, isLoading, isError, error, refetch, isFetching } =
    useAgentPolicy();
  const save = useSaveAgentPolicy();
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  const [form, setForm] = useState<FormState | null>(null);
  const [seeded, setSeeded] = useState<FormState | null>(null);
  const [seededRevision, setSeededRevision] = useState<number | null>(null);
  /** The foreign generation an in-progress edit is being held against, or `null`. */
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);

  /** Take the server's values, dropping whatever is in the form. The one deliberate discard. */
  const reseed = (settings: NonNullable<typeof data>) => {
    const next = seedFrom(settings.effective);
    setSeededRevision(settings.revision);
    setSeeded(next);
    setForm(next);
    setConflictRevision(null);
  };

  // Re-seed from the persisted truth on load and after every save, so the fields can never drift
  // from what the server actually stores. Keyed on the REVISION rather than on the response object:
  // a save bumps it (so the form re-seeds), while a background refetch that returns the same
  // generation leaves an operator's half-finished edit exactly where it was.
  //
  // `bumpRevision` fires on every policy write at EVERY scope, though, so that number also moves for
  // a write this operator did not make. `reseedAction` is where the three cases are decided and
  // argued; the only one that is not a plain re-seed is a foreign write against a dirty form, which
  // KEEPS the edit and raises the notice below rather than overwriting it.
  //
  // Adjusted during render, not in an effect — the React-sanctioned way to derive state from a
  // changed input, and the one that does not cause the cascading re-render an effect would.
  if (data) {
    const action = reseedAction({
      incomingRevision: data.revision,
      seededRevision,
      dirty: form !== null && seeded !== null && !sameForm(form, seeded),
      savedRevision: save.data?.revision,
    });
    if (action === "seed") reseed(data);
    else if (action === "conflict" && conflictRevision !== data.revision) {
      setConflictRevision(data.revision);
    }
  }

  if (isLoading || !form || !seeded) {
    return (
      <div className="space-y-6">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <CardTitle>
                <Skeleton className="h-5 w-40" />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("loadFailed")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <ArrowPathIcon className="size-4" />
            {t("retry")}
          </Button>
          <RequestIdNote requestId={requestId} />
        </CardContent>
      </Card>
    );
  }

  const intervalMinutes = intOrUndefined(form.intervalMinutes);
  const staleMinutes = intOrUndefined(form.staleAfterMinutes);
  const softwareMax = intOrUndefined(form.softwareMax);
  const intervalError =
    intervalMinutes === undefined ||
    intervalMinutes < MIN_MINUTES ||
    intervalMinutes > MAX_MINUTES
      ? t("interval.invalid", { min: MIN_MINUTES, max: MAX_MINUTES })
      : undefined;
  // Two independent constraints, both real. The RANGE is the schema's own (one tick to 7 days), and
  // the RELATIONSHIP is that it must clear the reporting interval, or the sweeper marks a perfectly
  // healthy host OFFLINE between two of its own reports — the false outage this field exists to stop.
  const staleError =
    staleMinutes === undefined ||
    staleMinutes < STALE_MIN_MINUTES ||
    staleMinutes > STALE_MAX_MINUTES
      ? t("stale.invalid", { min: STALE_MIN_MINUTES, max: STALE_MAX_MINUTES })
      : intervalMinutes !== undefined && staleMinutes <= intervalMinutes
        ? t("stale.belowInterval")
        : undefined;
  const softwareMaxError =
    softwareMax === undefined || softwareMax > AGENT_POLICY_SOFTWARE_MAX
      ? t("softwareMax.invalid", { max: AGENT_POLICY_SOFTWARE_MAX })
      : undefined;
  const globErrors: Partial<Record<keyof AgentPolicyExcludeForm, string>> = {};
  for (const { key } of EXCLUSIONS) {
    const bad = firstBadGlob(form[key]);
    if (bad) globErrors[key] = t("globs.invalid", { value: bad });
    else if (toGlobs(form[key]).length > AGENT_POLICY_GLOBS_MAX) {
      globErrors[key] = t("globs.tooMany", { max: AGENT_POLICY_GLOBS_MAX });
    }
  }
  const blocked =
    Boolean(intervalError) ||
    Boolean(staleError) ||
    Boolean(softwareMaxError) ||
    Object.keys(globErrors).length > 0;
  const dirty = !sameForm(form, seeded);

  const onSave = () => {
    if (blocked || intervalMinutes === undefined || staleMinutes === undefined) return;
    const body: AgentPolicyOverride = {
      intervalSeconds: intervalMinutes * 60,
      staleAfterSeconds: staleMinutes * 60,
      softwareMax: softwareMax ?? AGENT_POLICY_DEFAULT.softwareMax,
      collect: form.collect,
      exclude: {
        nicNames: toGlobs(form.nicNames),
        mountpoints: toGlobs(form.mountpoints),
        softwareNames: toGlobs(form.softwareNames),
      },
    };
    save.mutate(body, {
      onSuccess: (next) => toast.success(t("saved", { revision: next.revision })),
      onError: (err) => notifyError(err, t("saveFailed")),
    });
  };

  return (
    <div className="space-y-6">
      {/* ── Cadence ── the two numbers that constrain each other, side by side so the rule reads. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("cadence.title")}</CardTitle>
          <CardDescription>{t("cadence.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2 sm:items-start">
            <Field data-invalid={intervalError ? true : undefined}>
              <FieldLabel htmlFor="agent-policy-interval">
                {t("interval.label")}
              </FieldLabel>
              <Input
                id="agent-policy-interval"
                inputMode="numeric"
                aria-invalid={intervalError ? true : undefined}
                value={form.intervalMinutes}
                onChange={(e) =>
                  setForm({ ...form, intervalMinutes: e.target.value })
                }
              />
              <FieldDescription>
                {t("interval.help", { tick: AGENT_POLICY_TICK_SECONDS / 60 })}
              </FieldDescription>
              {intervalError ? <FieldError>{intervalError}</FieldError> : null}
            </Field>

            <Field data-invalid={staleError ? true : undefined}>
              <FieldLabel htmlFor="agent-policy-stale">
                {t("stale.label")}
              </FieldLabel>
              <Input
                id="agent-policy-stale"
                inputMode="numeric"
                aria-invalid={staleError ? true : undefined}
                value={form.staleAfterMinutes}
                onChange={(e) =>
                  setForm({ ...form, staleAfterMinutes: e.target.value })
                }
              />
              <FieldDescription>{t("stale.help")}</FieldDescription>
              {staleError ? <FieldError>{staleError}</FieldError> : null}
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ── What is collected ── the five switches plus the cap that only the software one spends. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("collect.title")}</CardTitle>
          <CardDescription>{t("collect.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="divide-y">
            {COLLECTORS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <span className="text-sm">{t(`collect.${key}`)}</span>
                <Switch
                  checked={form.collect[key]}
                  onCheckedChange={(checked) =>
                    setForm({
                      ...form,
                      collect: { ...form.collect, [key]: checked },
                    })
                  }
                  aria-label={t(`collect.${key}`)}
                />
              </div>
            ))}
          </div>

          <p className="text-sm text-muted-foreground">{t("collect.veto")}</p>

          <Field
            className="border-t pt-5"
            data-invalid={softwareMaxError ? true : undefined}
          >
            <FieldLabel htmlFor="agent-policy-software-max">
              {t("softwareMax.label")}
            </FieldLabel>
            <Input
              id="agent-policy-software-max"
              inputMode="numeric"
              className="sm:max-w-48"
              aria-invalid={softwareMaxError ? true : undefined}
              value={form.softwareMax}
              onChange={(e) => setForm({ ...form, softwareMax: e.target.value })}
            />
            <FieldDescription>{t("softwareMax.help")}</FieldDescription>
            {/* The cap is spent inside the software collector, so it does nothing while that is off. */}
            {form.collect.software ? null : (
              <FieldDescription>{t("softwareMax.inert")}</FieldDescription>
            )}
            {softwareMaxError ? (
              <FieldError>{softwareMaxError}</FieldError>
            ) : null}
          </Field>
        </CardContent>
      </Card>

      {/* ── Exclusions ── the most complex control on the page, and now the one with the most room. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("exclude.title")}</CardTitle>
          <CardDescription>
            {t("exclude.description", { max: AGENT_POLICY_GLOBS_MAX })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {EXCLUSIONS.map(({ key, collector }) => {
              const count = toGlobs(form[key]).length;
              return (
                <Field
                  key={key}
                  data-invalid={globErrors[key] ? true : undefined}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <FieldLabel htmlFor={`agent-policy-${key}`}>
                      {t(`exclude.${key}.label`)}
                    </FieldLabel>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t("exclude.count", {
                        count,
                        max: AGENT_POLICY_GLOBS_MAX,
                      })}
                    </span>
                  </div>
                  <Input
                    id={`agent-policy-${key}`}
                    value={form[key]}
                    placeholder={t(`exclude.${key}.placeholder`)}
                    aria-invalid={globErrors[key] ? true : undefined}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                  <FieldDescription>{t(`exclude.${key}.help`)}</FieldDescription>
                  {/* The agent gates the collector before it applies the list — an inert list is
                      saved faithfully and matched by nothing, which is worth saying here. */}
                  {form.collect[collector] ? null : (
                    <FieldDescription>
                      {t(`exclude.${key}.inert`)}
                    </FieldDescription>
                  )}
                  {globErrors[key] ? (
                    <FieldError>{globErrors[key]}</FieldError>
                  ) : null}
                </Field>
              );
            })}
          </FieldGroup>
        </CardContent>
      </Card>

      {/* One action bar for all three groups: the PUT replaces the whole instance layer, so the
          three cards are one edit and saving them separately would be a lie about the contract. */}
      <div className="space-y-3">
        {/* A write from another scope, another tab or the API moved the revision under a dirty
            form. The edit is still here and still unsent; reloading is the operator's call. */}
        {conflictRevision !== null && data ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <div className="space-y-3">
              <p className="text-sm">
                {t("conflict.body", { revision: conflictRevision })}
              </p>
              <Button variant="outline" size="sm" onClick={() => reseed(data)}>
                {t("conflict.reload")}
              </Button>
            </div>
          </Callout>
        ) : null}
        <p className="text-sm text-muted-foreground">{t("propagation")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSave} disabled={blocked || save.isPending}>
            {save.isPending ? t("saving") : t("save")}
          </Button>
          {dirty ? (
            <>
              <Button
                variant="ghost"
                onClick={() => setForm(seeded)}
                disabled={save.isPending}
              >
                {t("discard")}
              </Button>
              <StatusBadge tone="warning" dot className="animate-fade-in">
                {t("dirty")}
              </StatusBadge>
            </>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ms-auto"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
            {tc("refresh")}
          </Button>
        </div>
        <RequestIdNote requestId={requestId} />
      </div>
    </div>
  );
}
