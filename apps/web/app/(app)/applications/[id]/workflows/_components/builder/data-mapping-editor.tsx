"use client";

import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
 * The per-step data-mapping editor (frontend.md §5) — a repeatable target-field → value-source editor
 * over the shared `WorkflowDataMapping` (a flat `Record<string,string>`). v1 keeps the value source a
 * free template string (e.g. `{{ grantee.email }}`); the richer token-picker combobox is a fast-follow.
 * The mapping is logic-less by construction (the shared contract forbids code execution).
 */
export function DataMappingEditor({
  value,
  onChange,
}: {
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const t = useTranslations("workflow");
  const baseId = useId();
  const [pairs, setPairs] = useState<Pair[]>(() => toPairs(value));

  function update(next: Pair[]) {
    setPairs(next);
    onChange(toRecord(next));
  }

  function add() {
    update([...pairs, { id: `${baseId}-${pairs.length}-${Date.now()}`, key: "", value: "" }]);
  }

  function edit(id: string, patch: Partial<Pick<Pair, "key" | "value">>) {
    update(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function remove(id: string) {
    update(pairs.filter((p) => p.id !== id));
  }

  return (
    <div className="space-y-2">
      {pairs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("mapping.empty")}</p>
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
              />
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                ←
              </span>
              <Input
                value={pair.value}
                onChange={(e) => edit(pair.id, { value: e.target.value })}
                placeholder="{{ grantee.email }}"
                aria-label={t("mapping.valueLabel")}
                maxLength={2000}
                className="font-mono text-xs"
              />
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
