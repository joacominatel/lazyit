"use client";

import { XMarkIcon } from "@heroicons/react/24/outline";
import type { WorkflowStep } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseTemplate,
  type TemplateSegment,
  wrapToken,
} from "@/lib/workflow/template";
import { TokenPicker } from "./token-assist";

/**
 * A single body field's COMPOSER (issue #338) — build one value out of ≥2 tokens and/or literal text
 * WITHOUT enabling the global Advanced mode. It is a chip/segment editor: token segments render as
 * immutable `{{ … }}` chips, literal segments as small inline text inputs. The produced string is a
 * plain template (`"{{ grantee.firstName }} {{ grantee.lastName }}"`) — exactly what `renderTemplate`
 * already concatenates server-side — so it round-trips through the field-picker ↔ advanced toggle
 * (parsing it back yields the same segments).
 *
 * SEC-A5: every rendered piece is admin-authored template text / a token PATH — escaped React text
 * only, never raw-HTML injection.
 */
export function ValueComposer({
  value,
  onChange,
  priorSteps = [],
  onDone,
}: {
  value: string;
  onChange: (next: string) => void;
  priorSteps?: readonly WorkflowStep[];
  /** Called when the user collapses the composer (back to the single-token picker). */
  onDone?: () => void;
}) {
  const t = useTranslations("workflow");

  // The segments are derived from the current string each render — the string is the source of truth,
  // so the composer always agrees with what the advanced/raw editor would show.
  const segments = useMemo(() => parseTemplate(value), [value]);

  function commit(next: TemplateSegment[]) {
    onChange(segmentsToString(next));
  }

  function addToken(token: string) {
    // `token` already arrives wrapped (`{{ path }}`); parse it into a single token segment + append.
    const [segment] = parseTemplate(token);
    if (segment) commit([...segments, segment]);
  }

  function addLiteral() {
    commit([...segments, { type: "literal", text: " " }]);
  }

  function editLiteral(index: number, text: string) {
    commit(segments.map((s, i) => (i === index ? { type: "literal", text } : s)));
  }

  function removeSegment(index: number) {
    commit(segments.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {segments.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("compose.empty")}
          </span>
        ) : (
          segments.map((segment, index) =>
            segment.type === "token" ? (
              <span
                key={`tok-${index}-${segment.raw}`}
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary ring-1 ring-primary/20"
              >
                {`{{ ${segment.raw} }}`}
                <button
                  type="button"
                  onClick={() => removeSegment(index)}
                  aria-label={t("compose.removeToken")}
                  className="text-primary/70 hover:text-primary"
                >
                  <XMarkIcon className="size-3" />
                </button>
              </span>
            ) : (
              <span
                key={`lit-${index}`}
                className="inline-flex items-center gap-1"
              >
                <Input
                  value={segment.text}
                  onChange={(e) => editLiteral(index, e.target.value)}
                  aria-label={t("compose.literalLabel")}
                  placeholder={t("compose.literalPlaceholder")}
                  className="h-7 w-28 text-xs"
                  maxLength={500}
                />
                <button
                  type="button"
                  onClick={() => removeSegment(index)}
                  aria-label={t("compose.removeLiteral")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <XMarkIcon className="size-3" />
                </button>
              </span>
            ),
          )
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TokenPicker
          priorSteps={priorSteps}
          onInsert={addToken}
          triggerLabel={t("compose.addToken")}
          triggerClassName="h-7"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          onClick={addLiteral}
        >
          {t("compose.addText")}
        </Button>
        {onDone ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            onClick={onDone}
          >
            {t("compose.done")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Serialise composed segments back into a plain template string (the `renderTemplate` contract). */
function segmentsToString(segments: TemplateSegment[]): string {
  return segments
    .map((s) => (s.type === "token" ? wrapToken(s.raw) : s.text))
    .join("");
}
