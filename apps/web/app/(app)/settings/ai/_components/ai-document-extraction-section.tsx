"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import type { AiSettings } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { SettingRow, SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import { buildUpdate, documentExtractionAvailability } from "../_lib/ai-settings-form";
import { egressNeedsConsent } from "../_lib/ai-status";
import { AiEgressConfirm } from "./ai-egress-confirm";
import { AiErrorNotice } from "./ai-error-notice";

/**
 * What leaves lazyit when document extraction is on (the shared `AI_DOCUMENT_EXTRACTION_DISCLOSURE`,
 * localized): the whole document goes to the provider; nothing is saved until a person reviews it.
 */
export function DocumentExtractionDisclosure() {
  const t = useTranslations("aiSettings.documentExtraction.disclosure");
  return (
    <div className="space-y-1.5 text-sm">
      <p className="font-medium">{t("title")}</p>
      <p>{t("egress")}</p>
      <p>{t("review")}</p>
    </div>
  );
}

/**
 * Settings → AI → Capabilities: purchase *Document extraction* (ADR-0099 §11, #1477). Its own switch, OFF
 * by default and on every upgraded instance: turning it on lets a person send a document attached to a
 * purchase — an invoice, a quote, a delivery note, with its supplier, prices and tax IDs — to the
 * configured provider to draft the purchase. It needs the assistant on and a provider that reads
 * documents; otherwise the switch is disabled with the reason — but stays usable while on.
 *
 * Consent (#1540): the disclosure sits in the switch's "?" tip, and turning the switch ON opens
 * {@link AiEgressConfirm} with it in full — nothing is saved until confirmed. Off saves at once.
 */
export function AiDocumentExtractionSection({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.documentExtraction");
  const tLinks = useTranslations("aiSettings.links");
  const save = useAiConfigSave();
  const availability = documentExtractionAvailability(settings);
  const available = availability === "available";
  const enabled = settings.documentExtractionEnabled === true;
  const active = enabled && available;
  const [confirming, setConfirming] = useState(false);

  function apply(checked: boolean) {
    save.save(buildUpdate(settings, { documentExtractionEnabled: checked }), () => {
      setConfirming(false);
      toast.success(checked ? t("savedOn") : t("savedOff"));
    });
  }

  return (
    <SettingsSection
      title={t("title")}
      help={<p>{t("description")}</p>}
      helpHref={tLinks("documentExtraction")}
      status={<StatusBadge tone={active ? "success" : "neutral"}>{active ? t("on") : t("off")}</StatusBadge>}
    >
      <SettingRow
        label={t("switch.label")}
        htmlFor="ai-document-extraction-enabled"
        help={
          <>
            <p>{t("switch.description")}</p>
            <DocumentExtractionDisclosure />
          </>
        }
        helpHref={tLinks("documentExtraction")}
      >
        <Switch
          id="ai-document-extraction-enabled"
          checked={enabled}
          disabled={save.isPending || (!available && !enabled)}
          onCheckedChange={(checked) => {
            if (egressNeedsConsent(enabled, checked)) setConfirming(true);
            else apply(checked);
          }}
        />
      </SettingRow>

      {!available ? (
        <Callout tone="warning" icon={<InformationCircleIcon />}>
          <p className="text-sm">{t(`availability.${availability}`)}</p>
        </Callout>
      ) : null}

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
        <DocumentExtractionDisclosure />
      </AiEgressConfirm>
    </SettingsSection>
  );
}
