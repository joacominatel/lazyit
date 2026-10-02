"use client";

import type { ExtractionEvidence } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { warningKey } from "@/lib/purchases/extraction";
import { type FieldProposal, proposalAction } from "@/lib/purchases/extraction-review";
import { cn } from "@/lib/utils";

/**
 * What was read for a value: the verbatim text and its page — what catches a 1,000× separator error at a
 * glance (UX proposal §3.b). Shown when the field is hovered or focused (it sits inside a `group/field`), and
 * always when `always` (a flagged value). In the DOM throughout, so a screen reader reaches it.
 */
export function Evidence({ evidence, always = false }: { evidence: ExtractionEvidence | null; always?: boolean }) {
  const t = useTranslations("purchases.extraction");
  if (!evidence) return null;
  return (
    <p
      className={cn(
        "text-xs text-muted-foreground",
        !always && "sr-only group-focus-within/field:not-sr-only group-hover/field:not-sr-only",
      )}
    >
      {evidence.page !== null
        ? t("readOnPage", { text: evidence.text, page: evidence.page })
        : t("read", { text: evidence.text })}
    </p>
  );
}

/** The API's warnings on a value, each as a sentence. */
export function Warnings({ codes }: { codes: readonly string[] | undefined }) {
  const t = useTranslations("purchases.extraction.warnings");
  if (!codes || codes.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs font-medium text-warning-text">
      {codes.map((code, index) => (
        <li key={`${code}-${index}`}>{t(warningKey(code))}</li>
      ))}
    </ul>
  );
}

/** "Not read" — the field stays blank, never a guess. */
export function NotRead() {
  const t = useTranslations("purchases.extraction");
  return <p className="text-xs font-medium text-warning-text">{t("notRead")}</p>;
}

/** Everything a read value carries under its input: what was read, "not read", and the warnings. */
export function ReadNote({
  read,
  evidence,
  warnings,
}: {
  read: boolean;
  evidence: ExtractionEvidence | null;
  warnings?: readonly string[];
}) {
  const flagged = (warnings?.length ?? 0) > 0;
  return (
    <>
      {read ? <Evidence evidence={evidence} always={flagged} /> : <NotRead />}
      <Warnings codes={warnings} />
    </>
  );
}

/** The diff badge: fill, replace or unchanged. */
export function ActionBadge({ field, current, proposed }: { field: string; current: string; proposed: string }) {
  const t = useTranslations("purchases.extraction.action");
  const action = proposalAction(field, current, proposed);
  if (action === "unread") return null;
  return (
    <StatusBadge tone={action === "replace" ? "warning" : action === "fill" ? "info" : "neutral"}>
      {t(action)}
    </StatusBadge>
  );
}

/**
 * One proposed value as a row: apply it or not, the value (editable), what the purchase has now, and what
 * was read. Filling an empty field starts ticked; replacing never does; typing ticks it.
 */
export function ProposalRow({
  id,
  label,
  item,
  type = "text",
  currentText,
  note,
  error,
  onEdit,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  item: FieldProposal;
  type?: "text" | "date";
  /** How the purchase's current value reads (dates formatted, money with its label). */
  currentText?: string;
  /** An extra line under the value (e.g. the currency note). */
  note?: ReactNode;
  error?: string;
  onEdit: (value: string) => void;
  onToggle: (checked: boolean) => void;
  /** Replaces the plain input (e.g. a smart-entry field). */
  children?: ReactNode;
}) {
  const t = useTranslations("purchases.extraction");
  const action = proposalAction(item.field, item.current, item.proposed);
  const flagged = item.warnings.length > 0;
  return (
    <div
      className={cn(
        "group/field grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-lg border p-3",
        (flagged || !item.read) && "border-warning/50 bg-warning/5",
      )}
      {...(flagged ? { "data-review-flag": "" } : {})}
    >
      <Checkbox
        className="mt-1"
        checked={item.checked}
        disabled={action === "unread" || action === "same"}
        onCheckedChange={(checked) => onToggle(checked === true)}
        aria-label={t("applyField", { field: label })}
      />
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          <ActionBadge field={item.field} current={item.current} proposed={item.proposed} />
          {flagged ? <StatusBadge tone="warning">{t("check")}</StatusBadge> : null}
        </div>
        {children ?? (
          <Input
            id={id}
            type={type}
            value={item.proposed}
            onChange={(event) => onEdit(event.target.value)}
            aria-invalid={error ? true : undefined}
            className={type === "date" ? "font-mono" : undefined}
          />
        )}
        {action === "replace" || action === "same" ? (
          <p className="text-xs text-muted-foreground">{t("now", { value: currentText ?? item.current })}</p>
        ) : null}
        <ReadNote read={item.read} evidence={item.evidence} warnings={item.warnings} />
        {note}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
