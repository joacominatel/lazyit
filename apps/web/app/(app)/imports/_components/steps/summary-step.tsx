"use client";

import type { ImportSessionView } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useImportError } from "../use-import-error";

/** A label / value row in the detected-shape summary. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

/**
 * Step 2 — Parsed summary (ADR-0069 §1). A read-only confirmation of the detected shape (record
 * count, encoding, delimiter, BOM) + the detected columns, so the operator confirms the file parsed
 * as they expect before mapping. An empty file (0 rows) is a dead-end here — the continue button is
 * disabled with an explanatory note (go back and re-upload).
 */
export function SummaryStep({
  session,
  isLoading,
  error,
  onBack,
  onContinue,
}: {
  session: ImportSessionView | undefined;
  isLoading: boolean;
  error: unknown;
  onBack: () => void;
  onContinue: () => void;
}) {
  const t = useTranslations("imports");
  const { resolve } = useImportError();

  if (isLoading || !session) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive" role="alert">
          {resolve(error, "result")}
        </p>
        <Button type="button" variant="outline" onClick={onBack}>
          {t("common.startOver")}
        </Button>
      </div>
    );
  }

  const detected = session.detected;
  const headers = session.headers.length > 0 ? session.headers : (detected?.headers ?? []);
  const rowCount = session.rowCount;
  const hasRows = rowCount > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("summary.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("summary.description")}</p>
      </div>

      <div className="rounded-lg border divide-y px-4">
        <InfoRow label={t("summary.rowCount")}>{rowCount}</InfoRow>
        {detected && (
          <>
            <InfoRow label={t("summary.encoding")}>{detected.encoding}</InfoRow>
            <InfoRow label={t("summary.delimiter")}>
              {detected.dialect.delimiter ?? t("summary.delimiterNone")}
            </InfoRow>
            <InfoRow label={t("summary.bom")}>
              {detected.dialect.hadBom ? t("summary.bomYes") : t("summary.bomNo")}
            </InfoRow>
          </>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("summary.headers")}</h3>
        {headers.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {headers.map((header) => (
              <span
                key={header}
                className="rounded-md border bg-muted/40 px-2 py-0.5 text-xs font-medium"
              >
                {header}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("summary.noHeaders")}</p>
        )}
      </div>

      {!hasRows && (
        <p className="text-sm text-destructive" role="alert">
          {t("summary.noRows")}
        </p>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack}>
          {t("common.startOver")}
        </Button>
        <Button type="button" onClick={onContinue} disabled={!hasRows}>
          {t("summary.continue")}
        </Button>
      </div>
    </div>
  );
}
