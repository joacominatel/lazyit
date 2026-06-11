"use client";

import type { WorkflowStep } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { insertAt, knownRootsFor, validateTemplate } from "@/lib/workflow/template";
import { TokenHighlight, TokenPicker } from "./token-assist";

/**
 * The REST step PATH field with `{{ }}` token-assist (issue #337). The engine already templates
 * `step.path` (URL-encoded) via `renderTemplate(step.path, data, 'url')` — this surfaces that hidden
 * capability in the UI: an inline token picker that inserts `{{ … }}` at the cursor (scoped to PRIOR
 * steps), a highlighted preview of the template, and light validation (unknown root / unbalanced
 * braces / malformed path) BEFORE save. The HOST stays non-templatable (only path/query) — this field
 * is the path appended to the connection's baseUrl, so the SSRF posture (ADR-0054 §6.4) is unchanged.
 */
export function PathField({
  value,
  onChange,
  priorSteps = [],
}: {
  value: string;
  onChange: (next: string) => void;
  priorSteps?: readonly WorkflowStep[];
}) {
  const t = useTranslations("workflow");
  const inputRef = useRef<HTMLInputElement>(null);

  const knownRoots = useMemo(() => knownRootsFor(priorSteps), [priorSteps]);
  const validation = useMemo(
    () => validateTemplate(value, knownRoots),
    [value, knownRoots],
  );

  // Insert the chosen `{{ token }}` at the caret (or over the selection), then restore focus + caret.
  function handleInsert(token: string) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const { value: next, caret } = insertAt(value, start, end, token);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  const hasTemplate = value.includes("{{");

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Input
          ref={inputRef}
          id="step-path"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/rest/api/3/user/{{ grantee.id }}"
          className="font-mono text-xs"
          maxLength={2048}
          aria-invalid={validation.hasError || undefined}
          aria-describedby="step-path-help"
        />
        <TokenPicker priorSteps={priorSteps} onInsert={handleInsert} />
      </div>

      <p id="step-path-help" className="text-xs text-muted-foreground">
        {t("stepEditor.pathTokenHint")}
      </p>

      {hasTemplate ? (
        <div className="rounded-md border bg-muted/30 px-2.5 py-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("stepEditor.pathPreview")}
          </p>
          <TokenHighlight template={value} />
        </div>
      ) : null}

      {validation.unbalanced ? (
        <p className="text-xs text-destructive" role="alert">
          {t("stepEditor.tokenUnbalanced")}
        </p>
      ) : null}
      {validation.malformedPaths.length > 0 ? (
        <p className="text-xs text-destructive" role="alert">
          {t("stepEditor.tokenMalformed", {
            tokens: validation.malformedPaths.join(", "),
          })}
        </p>
      ) : null}
      {validation.unknownRoots.length > 0 ? (
        <p className="text-xs text-destructive" role="alert">
          {t("stepEditor.tokenUnknownRoot", {
            roots: validation.unknownRoots.join(", "),
          })}
        </p>
      ) : null}
      {validation.unknownFilters.length > 0 ? (
        <p className="text-xs text-warning">
          {t("stepEditor.tokenUnknownFilter", {
            filters: validation.unknownFilters.join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}
