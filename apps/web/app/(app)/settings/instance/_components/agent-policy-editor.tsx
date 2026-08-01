"use client";

import { ArrowPathIcon, SignalIcon } from "@heroicons/react/24/outline";
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
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import {
  useAgentPolicy,
  useSaveAgentPolicy,
} from "@/lib/api/hooks/use-agent-policy";
import { notifyError } from "@/lib/api/notify-error";

/** The five collectors, in the order the policy schema declares them. */
const COLLECTORS: readonly (keyof AgentPolicyCollect)[] = [
  "hardware",
  "disks",
  "nics",
  "software",
  "containers",
];

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
interface FormState {
  intervalMinutes: string;
  staleAfterMinutes: string;
  softwareMax: string;
  collect: AgentPolicyCollect;
  nicNames: string;
  mountpoints: string;
  softwareNames: string;
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

/**
 * Settings → Instance: the reporting-agent policy editor (ADR-0074 §7 amendment, issue #1140).
 *
 * This is the surface that replaces SSH-ing to every host to edit `/etc/lazyit-agent/config`. What
 * it saves is the INSTANCE DEFAULT layer; the per-service-account and per-node scopes exist in the
 * API but have no editor in this build, which the panel says out loud rather than implying.
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
 */
export function AgentPolicyEditor() {
  const t = useTranslations("settings.agentPolicy");
  const { data, isLoading, isError, error, refetch, isFetching } =
    useAgentPolicy();
  const save = useSaveAgentPolicy();
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  const [form, setForm] = useState<FormState | null>(null);
  const [seededRevision, setSeededRevision] = useState<number | null>(null);

  // Re-seed from the persisted truth on load and after every save, so the fields can never drift
  // from what the server actually stores. Keyed on the REVISION rather than on the response object:
  // a save bumps it (so the form re-seeds), while a background refetch that returns the same
  // generation leaves an operator's half-finished edit exactly where it was.
  //
  // Adjusted during render, not in an effect — the React-sanctioned way to derive state from a
  // changed input, and the one that does not cause the cascading re-render an effect would.
  if (data && seededRevision !== data.revision) {
    setSeededRevision(data.revision);
    setForm({
      intervalMinutes: String(Math.round(data.effective.intervalSeconds / 60)),
      staleAfterMinutes: String(Math.round(data.effective.staleAfterSeconds / 60)),
      softwareMax: String(data.effective.softwareMax),
      collect: { ...data.effective.collect },
      nicNames: toText(data.effective.exclude.nicNames),
      mountpoints: toText(data.effective.exclude.mountpoints),
      softwareNames: toText(data.effective.exclude.softwareNames),
    });
  }

  if (isLoading || !form) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </CardContent>
      </Card>
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
  const globErrors: Partial<Record<keyof FormState, string>> = {};
  for (const key of ["nicNames", "mountpoints", "softwareNames"] as const) {
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SignalIcon className="size-5 text-muted-foreground" />
          {t("title")}
        </CardTitle>
        <CardDescription>
          {t("subtitle", { revision: data?.revision ?? 0 })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="agent-policy-interval">
              {t("interval.label")}
            </FieldLabel>
            <Input
              id="agent-policy-interval"
              inputMode="numeric"
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

          <Field>
            <FieldLabel htmlFor="agent-policy-stale">
              {t("stale.label")}
            </FieldLabel>
            <Input
              id="agent-policy-stale"
              inputMode="numeric"
              value={form.staleAfterMinutes}
              onChange={(e) =>
                setForm({ ...form, staleAfterMinutes: e.target.value })
              }
            />
            <FieldDescription>{t("stale.help")}</FieldDescription>
            {staleError ? <FieldError>{staleError}</FieldError> : null}
          </Field>

          <Field>
            <FieldLabel>{t("collect.label")}</FieldLabel>
            <FieldDescription>{t("collect.help")}</FieldDescription>
            <div className="mt-2 space-y-2">
              {COLLECTORS.map((key) => (
                <div key={key} className="flex items-center justify-between gap-4">
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
            <FieldDescription>{t("collect.veto")}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-policy-software-max">
              {t("softwareMax.label")}
            </FieldLabel>
            <Input
              id="agent-policy-software-max"
              inputMode="numeric"
              value={form.softwareMax}
              onChange={(e) => setForm({ ...form, softwareMax: e.target.value })}
            />
            <FieldDescription>{t("softwareMax.help")}</FieldDescription>
            {softwareMaxError ? (
              <FieldError>{softwareMaxError}</FieldError>
            ) : null}
          </Field>

          {(["nicNames", "mountpoints", "softwareNames"] as const).map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={`agent-policy-${key}`}>
                {t(`exclude.${key}.label`)}
              </FieldLabel>
              <Input
                id={`agent-policy-${key}`}
                value={form[key]}
                placeholder={t(`exclude.${key}.placeholder`)}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
              <FieldDescription>{t(`exclude.${key}.help`)}</FieldDescription>
              {globErrors[key] ? (
                <FieldError>{globErrors[key]}</FieldError>
              ) : null}
            </Field>
          ))}
        </FieldGroup>

        <p className="mt-4 text-sm text-muted-foreground">{t("propagation")}</p>

        <div className="mt-4 flex items-center gap-2">
          <Button onClick={onSave} disabled={blocked || save.isPending}>
            {save.isPending ? t("saving") : t("save")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <ArrowPathIcon className="size-4" />
            {t("retry")}
          </Button>
        </div>
        <RequestIdNote requestId={requestId} />
      </CardContent>
    </Card>
  );
}
