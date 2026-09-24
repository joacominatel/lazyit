"use client";

import {
  ArrowPathIcon,
  BeakerIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import { AI_PROVIDER_DESCRIPTORS, type AiSettings } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  useTestAiConnection,
  useUpdateAiConfig,
} from "@/lib/api/hooks/use-ai-config";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";
import {
  AI_WIZARD_STEPS,
  type AiWizardStep,
  buildUpdate,
  type ConnectionDraft,
  draftFromSettings,
  draftToPatch,
  initialWizardStep,
  switchProvider,
} from "../_lib/ai-settings-form";
import {
  AiCredentialsFields,
  AiModelFields,
  AiProviderPicker,
  isDraftSavable,
} from "./ai-connection-fields";
import { AiErrorNotice } from "./ai-error-notice";
import { AiTestResult } from "./ai-test-result";

/** Where the admin lands after enabling: a hard reload, as the CEO described (frontend.md Fork E). */
const ENABLED_URL = "/settings/ai?enabled=1";

/**
 * Settings → AI while the assistant is OFF: the five-step setup (frontend.md §5.3). Provider →
 * credentials → model → test → enable. Steps 2 and 3 save a DISABLED draft (the SMTP pattern), so the
 * key is stored encrypted as soon as it is typed and never kept in the page; the test runs against the
 * saved configuration; and the last step records the egress-disclosure acknowledgement with the enable
 * — the API runs the enable gate again and has the last word. A saved draft reopens at the first step
 * that still needs the admin.
 */
export function AiSetupWizard({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.wizard");
  const { dateTime } = useFormatters();
  const [step, setStep] = useState<AiWizardStep>(() => initialWizardStep(settings));
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftFromSettings(settings));
  const [acknowledged, setAcknowledged] = useState(false);
  const save = useUpdateAiConfig();
  const test = useTestAiConnection();

  const index = AI_WIZARD_STEPS.indexOf(step);
  const descriptor = AI_PROVIDER_DESCRIPTORS[draft.provider];
  const disclosureDone = settings.disclosureAcknowledgedAt !== null;

  function go(next: AiWizardStep) {
    save.reset();
    setStep(next);
  }

  function update(patch: Partial<ConnectionDraft>) {
    setDraft((current) =>
      patch.provider ? switchProvider(current, patch.provider, settings) : { ...current, ...patch },
    );
  }

  /** Save the draft connection as a disabled configuration, then move on. The typed key is dropped. */
  function saveDraft(next: AiWizardStep) {
    save.mutate(buildUpdate(settings, { ...draftToPatch(draft), enabled: false }), {
      onSuccess: () => {
        setDraft((current) => ({ ...current, apiKey: "" }));
        test.reset();
        setStep(next);
      },
    });
  }

  function enable() {
    save.mutate(
      buildUpdate(settings, {
        enabled: true,
        acknowledgeDisclosure: disclosureDone ? undefined : true,
      }),
      // A HARD reload on purpose (frontend.md Fork E): it resets every client state, the chat included.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      { onSuccess: () => window.location.assign(ENABLED_URL) },
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>{t("title")}</CardTitle>
          </div>
          <span className="text-sm text-muted-foreground tabular-nums">
            {t("stepOf", { current: index + 1, total: AI_WIZARD_STEPS.length })}
          </span>
        </div>
        <CardDescription>{t("subtitle")}</CardDescription>
        <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {AI_WIZARD_STEPS.map((name, position) => (
            <li
              key={name}
              aria-current={name === step ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5",
                name === step ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border font-mono text-xs",
                  position <= index && "border-primary",
                )}
              >
                {position + 1}
              </span>
              {t(`steps.${name}`)}
            </li>
          ))}
        </ol>
      </CardHeader>

      <CardContent className="space-y-4">
        {step === "provider" ? (
          <>
            <p className="text-sm text-muted-foreground">{t("provider.intro")}</p>
            <AiProviderPicker
              value={draft.provider}
              onChange={(provider) => update({ provider })}
            />
          </>
        ) : null}

        {step === "credentials" ? (
          <AiCredentialsFields settings={settings} draft={draft} onChange={update} />
        ) : null}

        {step === "model" ? <AiModelFields draft={draft} onChange={update} /> : null}

        {step === "test" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("test.intro", {
                provider: descriptor.label,
                model: settings.model ?? "—",
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => test.mutate({})}
              disabled={test.isPending}
            >
              {test.isPending ? <ArrowPathIcon className="animate-spin" /> : <BeakerIcon />}
              {test.data ? t("test.again") : t("test.run")}
            </Button>
            {test.data ? <AiTestResult result={test.data} /> : null}
            <AiErrorNotice error={test.error} />
          </div>
        ) : null}

        {step === "enable" ? (
          <div className="space-y-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-muted-foreground">{t("review.provider")}</dt>
              <dd>{settings.provider ? AI_PROVIDER_DESCRIPTORS[settings.provider].label : "—"}</dd>
              <dt className="text-muted-foreground">{t("review.model")}</dt>
              <dd className="font-mono">{settings.model ?? "—"}</dd>
              {settings.baseUrl ? (
                <>
                  <dt className="text-muted-foreground">{t("review.baseUrl")}</dt>
                  <dd className="font-mono break-all">{settings.baseUrl}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t("review.key")}</dt>
              <dd>{settings.apiKeySet ? t("review.keyStored") : t("review.keyNone")}</dd>
            </dl>

            <div className="space-y-2 rounded-lg border p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden />
                {t("disclosure.title")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("disclosure.body", { provider: descriptor.label })}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t("disclosure.sent")}</li>
                <li>{t("disclosure.notSent")}</li>
                <li>{t("disclosure.retention")}</li>
              </ul>
              {disclosureDone ? (
                <p className="text-sm">
                  {t("disclosure.alreadyAcknowledged", {
                    when: dateTime(settings.disclosureAcknowledgedAt as string),
                  })}
                </p>
              ) : (
                <div className="flex items-start gap-2 pt-1">
                  <Checkbox
                    id="ai-disclosure"
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="ai-disclosure" className="text-sm font-normal leading-snug">
                    {t("disclosure.checkbox", { provider: descriptor.label })}
                  </Label>
                </div>
              )}
            </div>
          </div>
        ) : null}

        <AiErrorNotice error={save.error} />
      </CardContent>

      <CardFooter className="flex flex-wrap justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => go(AI_WIZARD_STEPS[Math.max(0, index - 1)] as AiWizardStep)}
          disabled={index === 0 || save.isPending}
        >
          {t("back")}
        </Button>

        {step === "provider" ? (
          <Button type="button" onClick={() => go("credentials")}>
            {t("next")}
          </Button>
        ) : null}
        {step === "credentials" ? (
          <Button
            type="button"
            onClick={() => saveDraft("model")}
            disabled={save.isPending || !isDraftSavable(settings, draft, { requireModel: false })}
          >
            {save.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {t("saveContinue")}
          </Button>
        ) : null}
        {step === "model" ? (
          <Button
            type="button"
            onClick={() => saveDraft("test")}
            disabled={save.isPending || !isDraftSavable(settings, draft, { requireModel: true })}
          >
            {save.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {t("saveContinue")}
          </Button>
        ) : null}
        {step === "test" ? (
          <Button
            type="button"
            onClick={() => go("enable")}
            disabled={!test.data?.ok}
            title={test.data?.ok ? undefined : t("test.continueHint")}
          >
            {t("next")}
          </Button>
        ) : null}
        {step === "enable" ? (
          <Button
            type="button"
            onClick={enable}
            disabled={save.isPending || (!disclosureDone && !acknowledged)}
          >
            {save.isPending ? <ArrowPathIcon className="animate-spin" /> : <SparklesIcon />}
            {t("enable")}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
