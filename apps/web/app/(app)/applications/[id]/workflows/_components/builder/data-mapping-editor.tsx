"use client";

import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { WorkflowStep } from "@lazyit/shared";
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

/**
 * The per-step data-mapping editor (frontend.md §5, issue #300) — a repeatable target-field →
 * value-source editor over the shared `WorkflowDataMapping` (a flat `Record<string,string>`).
 *
 * The DEFAULT value source is a **field picker** (a combobox of the context tokens — grantee /
 * application / grant / run context + prior-step outputs), so the operator chooses a value by NAME
 * instead of hand-typing `{{ grantee.email }}`. A per-editor **Advanced** toggle reveals the raw
 * `{{ token }}` template input for power users (literals, composite templates) — both modes write the
 * identical persisted string. The mapping is logic-less by construction (the shared contract forbids
 * code execution); the picker is FE-derived (the shared token catalog is issue #284, deferred).
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
            onCheckedChange={setAdvanced}
            aria-label={t("mapping.advancedAria")}
          />
          {t("mapping.advanced")}
        </label>
      </div>

      {pairs.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          {t("mapping.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {pairs.map((pair) => (
            <li key={pair.id} className="flex items-center gap-2">
              <Input
                value={pair.key}
                onChange={(e) => edit(pair.id, { key: e.target.value })}
                placeholder={t("mapping.fieldPlaceholder")}
                aria-label={t("mapping.fieldLabel")}
                maxLength={200}
                className="w-2/5 shrink-0"
              />
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                ←
              </span>
              <div className="min-w-0 flex-1">
                {advanced ? (
                  <Input
                    value={pair.value}
                    onChange={(e) => edit(pair.id, { value: e.target.value })}
                    placeholder="{{ grantee.email }}"
                    aria-label={t("mapping.valueLabel")}
                    maxLength={2000}
                    className="font-mono text-xs"
                  />
                ) : (
                  <ValueSourcePicker
                    value={pair.value}
                    items={tokenItems}
                    onChange={(v) => edit(pair.id, { value: v })}
                  />
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
          ))}
        </ul>
      )}
      <Button type="button" size="sm" variant="outline" onClick={add}>
        <PlusIcon />
        {t("mapping.add")}
      </Button>
    </div>
  );
}

/**
 * The field-picker value source: a combobox over the context tokens. A value that is exactly one
 * `{{ token }}` reference resolves to a selected row; anything else (a literal, a composite template
 * authored in advanced mode) shows verbatim in the trigger so it is never silently dropped — switch to
 * Advanced to edit it as raw text.
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
  // operator sees it and knows to use Advanced mode to change it.
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
