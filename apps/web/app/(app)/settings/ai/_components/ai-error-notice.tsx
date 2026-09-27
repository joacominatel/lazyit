"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Callout } from "@/components/callout";
import { RequestIdNote } from "@/components/request-id-note";
import { describeAiSettingsError } from "../_lib/ai-settings-form";
import { AiTestResult } from "./ai-test-result";

/**
 * Inline explanation of a failed `/config/ai` call. Every 409 / 400 / 422 the API can answer maps to a
 * sentence that says what happened and what to do (`describeAiSettingsError`); the failed connection
 * test is shown when the enable gate ran one, and the request id is always offered for reporting.
 * Rendered next to the action that failed, so the admin never has to hunt for a toast.
 */
export function AiErrorNotice({ error }: { error: unknown }) {
  const t = useTranslations("aiSettings.errors");
  if (!error) return null;
  const info = describeAiSettingsError(error);
  const text = info.message
    ? t(info.key, { message: info.message })
    : t(info.key);

  return (
    <Callout tone="warning" icon={<ExclamationTriangleIcon />} role="alert">
      <div className="space-y-2">
        <p className="text-sm">{text}</p>
        {info.test ? <AiTestResult result={info.test} /> : null}
        <RequestIdNote requestId={info.requestId} />
      </div>
    </Callout>
  );
}
