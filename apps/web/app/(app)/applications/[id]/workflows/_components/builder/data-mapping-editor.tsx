"use client";

import {
  PencilSquareIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { WorkflowStep } from "@lazyit/shared";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { Combobox, type ComboboxItem } from "@/components/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  buildContextTokens,
  templateToToken,
  tokenToTemplate,
} from "@/lib/workflow/context-tokens";
import {
  jsonToMapping,
  mappingToJson,
  parseTemplate,
} from "@/lib/workflow/template";
import { ValueComposer } from "./value-composer";

// The CodeMirror advanced editor is client-only and heavy — load it on demand so its bundle never
// ships on the initial builder route and never runs during SSR (issue #339).
const JsonTemplateEditor = dynamic(() => import("./json-template-editor"), {
  ssr: false,
  loading: () => (
    <div className="h-36 animate-pulse rounded-lg border bg-muted/30" />
  ),
});

interface Pair {
  /** Stable id so React keys survive edits to the key/value text. */
  id: string;
  key: string;
  value: string;
}

function toPairs(value: Record<string, string> | undefined): Pair[] {
  return Object.entries(value ?? {}).map(([key, val], i) => ({
    id: `${i}-${key}`,
    key,
    value: val,
  }));
}

function toRecord(pairs: Pair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key.length > 0) record[key] = pair.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

/** Is this value a single `{{ token }}` reference (so the field picker can represent it)? */
function isSingleToken(value: string): boolean {
  return templateToToken(value) !== undefined;
}

/**
 * Is this value a composite — i.e. NOT exactly one `{{ token }}`, yet not empty? Free text or a mix of
 * tokens + literal text needs the composer / advanced mode, not the single-token picker.
 */
function isComposite(value: string): boolean {
  if (value.trim() === "" || isSingleToken(value)) return false;
  return parseTemplate(value).length >= 1;
}

/** The pair ids whose value loads as a composite (so the composer opens for them up front). */
function compositeIds(pairs: Pair[]): Set<string> {
  const ids = new Set<string>();
  for (const pair of pairs) {
    if (isComposite(pair.value)) ids.add(pair.id);
  }
  return ids;
}

/**
 * The per-step data-mapping editor (frontend.md §5, issue #300) — a repeatable target-field →
 * value-source editor over the shared `WorkflowDataMapping` (a flat `Record<string,string>`).
 *
 * Three authoring modes, all writing the IDENTICAL persisted template string:
 *
 *  - **Field picker** (default) — a combobox of the context tokens, so the operator chooses a value by
 *    NAME instead of hand-typing `{{ grantee.email }}`.
 *  - **Per-field compose** (issue #338) — a chip/segment composer lets a SINGLE field be built from
 *    ≥2 tokens and/or literal text (`"{{ a }} {{ b }}"`) WITHOUT flipping the whole editor to advanced.
 *  - **Advanced** (issue #339) — a CodeMirror JSON editor over the WHOLE mapping, with JSON lint,
 *    `{{ }}` token autocomplete (same `buildContextTokens` source) and token highlighting.
 *
 * The mapping is logic-less by construction (the shared contract forbids code execution); the picker /
 * composer are FE-derived (the shared token catalog is issue #284, deferred).
 */
export function DataMappingEditor({
  value,
  onChange,
  priorSteps = [],
}: {
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
  /** Steps that precede the edited one — their outputs are in-scope value sources (frontend.md §5a). */
  priorSteps?: WorkflowStep[];
}) {
  const t = useTranslations("workflow");
  const baseId = useId();
  const [pairs, setPairs] = useState<Pair[]>(() => toPairs(value));
  const [advanced, setAdvanced] = useState(false);
  // Per-field "compose" mode: the set of pair ids currently shown as a segment composer. A composite
  // value loads with its composer already open (so it isn't hidden behind a picker that can't show it).
  const [composing, setComposing] = useState<Set<string>>(() =>
    compositeIds(toPairs(value)),
  );
  // The advanced editor's live JSON buffer (kept separate so an invalid edit doesn't drop the mapping).
  const [jsonDraft, setJsonDraft] = useState<string>(() => mappingToJson(value));
  const [jsonError, setJsonError] = useState<string | undefined>(undefined);

  const tokenItems = useMemo<ComboboxItem[]>(
    () =>
      buildContextTokens(priorSteps).map((token) => ({
        value: token.path,
        // The trigger/row reads as the dotted path so the operator sees exactly what gets templated;
        // matching also keys on the human leaf label + group heading so typing "email" or "First name"
        // both find the row.
        label: token.path,
        keywords: [token.label, t(`tokenGroup.${token.group}`)],
      })),
    [priorSteps, t],
  );

  function update(next: Pair[]) {
    setPairs(next);
    onChange(toRecord(next));
  }

  function add() {
    update([
      ...pairs,
      { id: `${baseId}-${pairs.length}-${Date.now()}`, key: "", value: "" },
    ]);
  }

  function edit(id: string, patch: Partial<Pick<Pair, "key" | "value">>) {
    update(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function remove(id: string) {
    update(pairs.filter((p) => p.id !== id));
    setCompose(id, false);
  }

  function setCompose(id: string, on: boolean) {
    setComposing((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Switching to advanced seeds the JSON buffer from the current mapping; switching back re-derives the
  // pairs from whatever JSON last parsed cleanly (round-trip through the toggle).
  function toggleAdvanced(on: boolean) {
    if (on) {
      setJsonDraft(mappingToJson(toRecord(pairs)));
      setJsonError(undefined);
    } else {
      const parsed = jsonToMapping(jsonDraft);
      if (!parsed.error) {
        const nextPairs = toPairs(parsed.mapping);
        setPairs(nextPairs);
        onChange(parsed.mapping);
        setComposing(compositeIds(nextPairs));
      }
      // If the JSON was invalid, keep the last good pairs (already in state) and just close advanced.
    }
    setAdvanced(on);
  }

  function onJsonChange(text: string) {
    setJsonDraft(text);
    const parsed = jsonToMapping(text);
    if (parsed.error) {
      setJsonError(parsed.error);
      return;
    }
    setJsonError(undefined);
    onChange(parsed.mapping);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t("mapping.valueSourceHint")}
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={advanced}
            onCheckedChange={toggleAdvanced}
            aria-label={t("mapping.advancedAria")}
          />
          {t("mapping.advanced")}
        </label>
      </div>

      {advanced ? (
        <div className="space-y-2">
          <JsonTemplateEditor
            value={jsonDraft}
            onChange={onJsonChange}
            priorSteps={priorSteps}
            ariaLabel={t("mapping.advancedAria")}
          />
          {jsonError ? (
            <p className="text-xs text-destructive" role="alert">
              {t("mapping.jsonError", { error: jsonError })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("mapping.jsonHint")}
            </p>
          )}
        </div>
      ) : pairs.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          {t("mapping.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {pairs.map((pair) => {
            const isComposing = composing.has(pair.id);
            return (
              <li key={pair.id} className="flex items-start gap-2">
                <Input
                  value={pair.key}
                  onChange={(e) => edit(pair.id, { key: e.target.value })}
                  placeholder={t("mapping.fieldPlaceholder")}
                  aria-label={t("mapping.fieldLabel")}
                  maxLength={200}
                  className="w-2/5 shrink-0"
                />
                <span
                  className="mt-2 shrink-0 text-muted-foreground"
                  aria-hidden
                >
                  ←
                </span>
                <div className="min-w-0 flex-1">
                  {isComposing ? (
                    <ValueComposer
                      value={pair.value}
                      onChange={(v) => edit(pair.id, { value: v })}
                      priorSteps={priorSteps}
                      onDone={() => setCompose(pair.id, false)}
                    />
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <div className="min-w-0 flex-1">
                        <ValueSourcePicker
                          value={pair.value}
                          items={tokenItems}
                          onChange={(v) => edit(pair.id, { value: v })}
                        />
                      </div>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setCompose(pair.id, true)}
                        aria-label={t("compose.open")}
                        title={t("compose.open")}
                      >
                        <PencilSquareIcon />
                      </Button>
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => remove(pair.id)}
                  aria-label={t("mapping.removeAria")}
                >
                  <XMarkIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {advanced ? null : (
        <Button type="button" size="sm" variant="outline" onClick={add}>
          <PlusIcon />
          {t("mapping.add")}
        </Button>
      )}
    </div>
  );
}

/**
 * The field-picker value source: a combobox over the context tokens. A value that is exactly one
 * `{{ token }}` reference resolves to a selected row; anything else (a literal, a composite template
 * authored via the composer / advanced mode) shows verbatim in the trigger so it is never silently
 * dropped — use the compose affordance or Advanced to edit it.
 */
function ValueSourcePicker({
  value,
  items,
  onChange,
}: {
  value: string;
  items: ComboboxItem[];
  onChange: (value: string) => void;
}) {
  const t = useTranslations("workflow");
  const selectedToken = templateToToken(value);
  // A non-token, non-empty value (literal / composite) has no matching row — surface it verbatim so the
  // operator sees it and knows to use the composer / Advanced mode to change it.
  const customLabel =
    value.trim().length > 0 && !selectedToken ? value : undefined;

  return (
    <Combobox
      value={selectedToken ?? (customLabel ? value : "")}
      selectedLabel={customLabel}
      items={items}
      onValueChange={(path) => onChange(path ? tokenToTemplate(path) : "")}
      placeholder={t("mapping.pickField")}
      searchPlaceholder={t("mapping.searchFields")}
      emptyText={t("mapping.noFields")}
    />
  );
}
