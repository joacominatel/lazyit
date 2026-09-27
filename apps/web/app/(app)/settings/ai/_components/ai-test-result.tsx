"use client";

import {
  CheckCircleIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import type { AiConnectionTestResult } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { testErrorKey } from "../_lib/ai-settings-form";

const CHECKS = ["auth", "model", "toolCalling"] as const;

/**
 * The outcome of a connection test (`POST /config/ai/test`, or the one the enable gate ran): one row
 * per check — passed, failed, or not run — the latency, and the reason when it failed. Status is never
 * colour alone: every row carries an icon and a word.
 */
export function AiTestResult({ result }: { result: AiConnectionTestResult }) {
  const t = useTranslations("aiSettings.test");
  const errorKey = testErrorKey(result.error?.code);

  return (
    <div className="space-y-3 rounded-lg border p-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge tone={result.ok ? "success" : "danger"}>
          {result.ok ? t("passed") : t("failed")}
        </StatusBadge>
        {result.latencyMs !== null ? (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {t("latency", { ms: result.latencyMs })}
          </span>
        ) : null}
      </div>
      <ul className="space-y-1.5 text-sm">
        {CHECKS.map((check) => {
          const value = result.checks[check];
          return (
            <li key={check} className="flex items-center gap-2">
              {value === true ? (
                <CheckCircleIcon className="size-4 text-success" aria-hidden />
              ) : value === false ? (
                <XCircleIcon className="size-4 text-destructive" aria-hidden />
              ) : (
                <MinusCircleIcon className="size-4 text-muted-foreground" aria-hidden />
              )}
              <span className="flex-1">{t(`checks.${check}`)}</span>
              <span className="text-xs text-muted-foreground">
                {value === true
                  ? t("state.passed")
                  : value === false
                    ? t("state.failed")
                    : t("state.skipped")}
              </span>
            </li>
          );
        })}
      </ul>
      {result.error ? (
        <p className="text-sm">
          {errorKey ? t(`codes.${errorKey}`) : result.error.message}
          <span className="ml-1 font-mono text-xs text-muted-foreground">
            ({result.error.code})
          </span>
        </p>
      ) : null}
    </div>
  );
}
