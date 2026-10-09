"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import {
  AI_WEB_SEARCH_MAX_USES_MAX,
  AI_WEB_SEARCH_MAX_USES_MIN,
  type AiSettings,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { SettingRow, SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import {
  buildUpdate,
  parseWebSearchMaxUses,
  webSearchAvailability,
} from "../_lib/ai-settings-form";
import { egressNeedsConsent } from "../_lib/ai-status";
import { AiEgressConfirm } from "./ai-egress-confirm";
import { AiErrorNotice } from "./ai-error-notice";

/**
 * What leaves lazyit when web search is on: the query and the conversation context go to the
 * provider's search; results are untrusted; OpenAI searches a cached index. Shown in the switch's "?"
 * tip and, in full, in the confirmation when the switch is turned on.
 */
export function WebSearchDisclosure({ provider }: { provider: AiSettings["provider"] }) {
  const t = useTranslations("aiSettings.webSearch.disclosure");
  return (
    <div className="space-y-1.5 text-sm">
      <p className="font-medium">{t("title")}</p>
      <p>{t("egress")}</p>
      <p>{t("untrusted")}</p>
      {provider === "openai" ? <p>{t("openai")}</p> : null}
    </div>
  );
}

/**
 * Settings → AI → Capabilities: provider-native web search (#1389; ADR-0097 decision 3 as amended
 * 2026-09-24). The AI provider runs the search on its own servers — lazyit makes no request of its own.
 * Off by default. Where the configured provider or model has no native search the switch is disabled
 * with the reason (it stays usable while on, so it can always be turned off).
 *
 * Consent (#1540): what leaves lazyit sits in the switch's "?" tip, and turning the switch ON first
 * opens {@link AiEgressConfirm} with the full disclosure — nothing is saved until it is confirmed.
 * Turning it off saves at once. The page is admin-gated; the API is the real gate.
 */
export function AiWebSearchSection({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.webSearch");
  const tLinks = useTranslations("aiSettings.links");
  const save = useAiConfigSave();
  const availability = webSearchAvailability(settings);
  const available = availability === "available";
  const [maxUses, setMaxUses] = useState(String(settings.webSearchMaxUses));
  const [seededFrom, setSeededFrom] = useState(settings.webSearchMaxUses);
  const [confirming, setConfirming] = useState(false);

  // Re-seed when the stored cap changes (this card's save, or another admin's) — adjusted during render.
  if (seededFrom !== settings.webSearchMaxUses) {
    setSeededFrom(settings.webSearchMaxUses);
    setMaxUses(String(settings.webSearchMaxUses));
  }

  const parsed = parseWebSearchMaxUses(maxUses);
  const capChanged = parsed !== null && parsed !== settings.webSearchMaxUses;
  const active = settings.webSearchEnabled && available;

  function apply(checked: boolean) {
    save.save(buildUpdate(settings, { webSearchEnabled: checked }), () => {
      setConfirming(false);
      toast.success(checked ? t("savedOn") : t("savedOff"));
    });
  }

  return (
    <SettingsSection
      title={t("title")}
      help={<p>{t("description")}</p>}
      helpHref={tLinks("webSearch")}
      status={<StatusBadge tone={active ? "success" : "neutral"}>{active ? t("on") : t("off")}</StatusBadge>}
    >
      <SettingRow
        label={t("switch.label")}
        htmlFor="ai-web-search-enabled"
        help={
          <>
            <p>{t("switch.description")}</p>
            <p>{t("disclosure.conversations")}</p>
            <WebSearchDisclosure provider={settings.provider} />
          </>
        }
        helpHref={tLinks("webSearch")}
      >
        <Switch
          id="ai-web-search-enabled"
          checked={settings.webSearchEnabled}
          disabled={save.isPending || (!available && !settings.webSearchEnabled)}
          onCheckedChange={(checked) => {
            if (egressNeedsConsent(settings.webSearchEnabled, checked)) setConfirming(true);
            else apply(checked);
          }}
        />
      </SettingRow>

      {!available ? (
        <Callout tone="warning" icon={<InformationCircleIcon />}>
          <p className="text-sm">{t(`availability.${availability}`)}</p>
        </Callout>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed === null || !capChanged) return;
          save.save(buildUpdate(settings, { webSearchMaxUses: parsed }), () =>
            toast.success(t("maxUses.saved")),
          );
        }}
      >
        <SettingRow
          label={t("maxUses.label")}
          htmlFor="ai-web-search-max-uses"
          help={<p>{t("maxUses.description")}</p>}
          note={
            parsed === null ? (
              <span className="text-destructive-text" role="alert">
                {t("maxUses.invalid", {
                  min: AI_WEB_SEARCH_MAX_USES_MIN,
                  max: AI_WEB_SEARCH_MAX_USES_MAX,
                })}
              </span>
            ) : undefined
          }
        >
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
            className="h-8 w-20"
          />
          <Button type="submit" variant="outline" size="sm" disabled={!capChanged || save.isPending}>
            {t("maxUses.save")}
          </Button>
        </SettingRow>
      </form>

      <AiErrorNotice error={save.error} />

      <AiEgressConfirm
        open={confirming}
        onOpenChange={setConfirming}
        title={t("consent.title")}
        confirmLabel={t("consent.confirm")}
        onConfirm={() => apply(true)}
        isPending={save.isPending}
        error={save.error}
      >
        <WebSearchDisclosure provider={settings.provider} />
      </AiEgressConfirm>
    </SettingsSection>
  );
}
