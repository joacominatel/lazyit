"use client";

import { ArrowPathIcon, BeakerIcon, CpuChipIcon } from "@heroicons/react/24/outline";
import {
  AI_PROVIDER_DESCRIPTORS,
  AI_PROVIDER_KINDS,
  type AiProviderKind,
  type AiSettings,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAiConfigSave,
  useAiConnectionTest,
} from "@/lib/api/hooks/use-ai-config";
import {
  buildUpdate,
  type ConnectionDraft,
  draftFromSettings,
  draftToPatch,
  draftToTest,
  switchProvider,
} from "../_lib/ai-settings-form";
import {
  AiCredentialsFields,
  AiModelFields,
  isDraftSavable,
} from "./ai-connection-fields";
import { AiErrorNotice } from "./ai-error-notice";
import { AiTestResult } from "./ai-test-result";

/**
 * Settings → AI while the assistant is ON: the provider & model card (frontend.md §5.3 "editor").
 * Change the provider, the model, the extras or replace the key, test the DRAFT before saving (the
 * typed key travels inline; the saved one is used only for the same destination), then save. A change
 * to the connection makes the API re-run the connection test before it accepts the save — a failure is
 * explained inline and nothing is stored.
 */
export function AiConnectionEditor({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.editor.connection");
  const id = useId();
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftFromSettings(settings));
  const save = useAiConfigSave();
  const test = useAiConnectionTest();

  // Re-seed from the persisted truth after every save (and when another admin's change is read) —
  // adjusted during render, React's pattern for state derived from a changed prop.
  const [seed, setSeed] = useState(settings);
  if (seed !== settings) {
    setSeed(settings);
    setDraft(draftFromSettings(settings));
  }

  const dirty =
    draft.apiKey.trim() !== "" ||
    JSON.stringify(draftToPatch(draft)) !==
      JSON.stringify(draftToPatch(draftFromSettings(settings)));

  function update(patch: Partial<ConnectionDraft>) {
    test.clear();
    save.clearError();
    setDraft((current) =>
      patch.provider ? switchProvider(current, patch.provider, settings) : { ...current, ...patch },
    );
  }

  function onSave() {
    save.save(buildUpdate(settings, { ...draftToPatch(draft), enabled: true }), () => {
      test.clear();
      toast.success(t("saved"));
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CpuChipIcon className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>{t("title")}</CardTitle>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field>
          <FieldLabel htmlFor={`${id}-provider`}>{t("provider")}</FieldLabel>
          <Select
            value={draft.provider}
            onValueChange={(value) => update({ provider: value as AiProviderKind })}
          >
            <SelectTrigger id={`${id}-provider`} className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AI_PROVIDER_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {AI_PROVIDER_DESCRIPTORS[kind].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <AiCredentialsFields settings={settings} draft={draft} onChange={update} />
        <AiModelFields draft={draft} onChange={update} />
        {test.result ? <AiTestResult result={test.result} /> : null}
        <AiErrorNotice error={test.error ?? save.error} />
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => test.run(draftToTest(draft))}
          disabled={test.isPending || !isDraftSavable(settings, draft, { requireModel: true })}
        >
          {test.isPending ? <ArrowPathIcon className="animate-spin" /> : <BeakerIcon />}
          {t("test")}
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={
            save.isPending || !dirty || !isDraftSavable(settings, draft, { requireModel: true })
          }
        >
          {save.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}
