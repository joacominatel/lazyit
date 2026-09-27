"use client";

import { GlobeAltIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import {
  AI_WEB_SEARCH_MAX_USES_MAX,
  AI_WEB_SEARCH_MAX_USES_MIN,
  type AiSettings,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { HelpTip } from "@/components/help-tip";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import {
  buildUpdate,
  parseWebSearchMaxUses,
  webSearchAvailability,
} from "../_lib/ai-settings-form";
import { AiErrorNotice } from "./ai-error-notice";
import { AiFieldLabel } from "./ai-field-label";

/**
 * Settings → AI: provider-native web search (#1389; ADR-0097 decision 3 as amended 2026-09-24). The AI
 * provider runs the search on its own servers — lazyit makes no request of its own — so the card says
 * plainly what leaves: the query and the conversation context go to the provider's search. Off by
 * default. Where the configured provider or model has no native search the switch is disabled with the
 * reason (it stays usable while on, so it can always be turned off). It applies to conversations started
 * after the change; turning it off makes conversations that had it read-only. The page is admin-gated
 * (`AdminGate`, `settings:manage`); the API is the real gate.
 */
export function AiWebSearchSection({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.webSearch");
  const tLinks = useTranslations("aiSettings.links");
  const save = useAiConfigSave();
  const availability = webSearchAvailability(settings);
  const available = availability === "available";
  const [maxUses, setMaxUses] = useState(String(settings.webSearchMaxUses));
  const [seededFrom, setSeededFrom] = useState(settings.webSearchMaxUses);

  // Re-seed when the stored cap changes (this card's save, or another admin's) — adjusted during render,
  // not in an effect (https://react.dev/learn/you-might-not-need-an-effect).
  if (seededFrom !== settings.webSearchMaxUses) {
    setSeededFrom(settings.webSearchMaxUses);
    setMaxUses(String(settings.webSearchMaxUses));
  }

  const parsed = parseWebSearchMaxUses(maxUses);
  const capChanged = parsed !== null && parsed !== settings.webSearchMaxUses;
  const active = settings.webSearchEnabled && available;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GlobeAltIcon className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>{t("title")}</CardTitle>
            <HelpTip topic={t("title")} href={tLinks("webSearch")}>
              <p>{t("description")}</p>
            </HelpTip>
          </div>
          <StatusBadge tone={active ? "success" : "neutral"}>
            {active ? t("on") : t("off")}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field orientation="horizontal" className="rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-1 flex-col gap-0.5">
            <AiFieldLabel
              htmlFor="ai-web-search-enabled"
              className="font-medium"
              help={
                <>
                  <p>{t("switch.description")}</p>
                  <p>{t("disclosure.conversations")}</p>
                </>
              }
            >
              {t("switch.label")}
            </AiFieldLabel>
          </div>
          <Switch
            id="ai-web-search-enabled"
            checked={settings.webSearchEnabled}
            disabled={save.isPending || (!available && !settings.webSearchEnabled)}
            onCheckedChange={(checked) =>
              save.save(buildUpdate(settings, { webSearchEnabled: checked }), () =>
                toast.success(checked ? t("savedOn") : t("savedOff")),
              )
            }
          />
        </Field>
        <AiErrorNotice error={save.error} />

        {!available ? (
          <Callout tone="warning" icon={<InformationCircleIcon />}>
            <p className="text-sm">{t(`availability.${availability}`)}</p>
          </Callout>
        ) : null}

        <Callout tone="info" icon={<InformationCircleIcon />}>
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">{t("disclosure.title")}</p>
            <p>{t("disclosure.egress")}</p>
            <p>{t("disclosure.untrusted")}</p>
            {settings.provider === "openai" ? <p>{t("disclosure.openai")}</p> : null}
          </div>
        </Callout>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed === null || !capChanged) return;
            save.save(buildUpdate(settings, { webSearchMaxUses: parsed }), () =>
              toast.success(t("maxUses.saved")),
            );
          }}
        >
          <Field data-invalid={parsed === null || undefined} className="max-w-xs">
            <AiFieldLabel
              htmlFor="ai-web-search-max-uses"
              help={<p>{t("maxUses.description")}</p>}
            >
              {t("maxUses.label")}
            </AiFieldLabel>
            <Input
              id="ai-web-search-max-uses"
              type="number"
              inputMode="numeric"
              min={AI_WEB_SEARCH_MAX_USES_MIN}
              max={AI_WEB_SEARCH_MAX_USES_MAX}
              step={1}
              value={maxUses}
              aria-invalid={parsed === null || undefined}
              onChange={(event) => setMaxUses(event.target.value)}
            />
            {parsed === null ? (
              <FieldError>
                {t("maxUses.invalid", {
                  min: AI_WEB_SEARCH_MAX_USES_MIN,
                  max: AI_WEB_SEARCH_MAX_USES_MAX,
                })}
              </FieldError>
            ) : null}
          </Field>
          <Button type="submit" variant="outline" disabled={!capChanged || save.isPending}>
            {t("maxUses.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
