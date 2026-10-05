"use client";

import type { AssetStatus } from "@lazyit/shared";
import { Fragment, type ReactNode } from "react";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAssetStatusLabels } from "@/lib/api/hooks/use-asset-status-labels";
import { cn } from "@/lib/utils";
import { AssetStatusSwatch, useAssetStatusLabel } from "./asset-status-badge";
import {
  decodeStatusChoice,
  encodeStatusChoice,
  groupStatusOptions,
  hasCustomStatuses,
  labelOfChoice,
  type StatusChoice,
  type StatusLabelOption,
  type StatusOptionGroup,
} from "./asset-status-options";

/**
 * The asset status picker (ADR-0101, #1524) — ONE option model for every surface that sets or filters an
 * asset's status: options grouped by built-in status, the bare built-in first, then its custom statuses
 * (indented, with their colour). With no custom status configured it is the flat built-in list it always
 * was. The grouping and the value encoding live in `asset-status-options.ts`; this file only renders them,
 * as a Select ({@link AssetStatusSelect}) or as dropdown-menu items ({@link AssetStatusMenuOptions}).
 */

/**
 * The grouped status options. `current` is the asset's own custom status, added when the list cannot be
 * read (no `category:read`) so the current value still shows.
 */
export function useAssetStatusOptions(
  current?: StatusLabelOption | null,
): StatusOptionGroup[] {
  const { data } = useAssetStatusLabels();
  return groupStatusOptions(data, current);
}

/** The visible text of one option: colour dot + name, plus (`withKind`) its built-in status. */
function OptionText({
  status,
  label,
  withKind = false,
}: {
  status: AssetStatus;
  label: StatusLabelOption | null;
  withKind?: boolean;
}) {
  const statusLabel = useAssetStatusLabel();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AssetStatusSwatch status={status} color={label?.color} />
      <span className="truncate">{label ? label.name : statusLabel(status)}</span>
      {label && withKind ? (
        <span className="shrink-0 text-muted-foreground">· {statusLabel(status)}</span>
      ) : null}
    </span>
  );
}

/**
 * A Select over the grouped options. `value` is the current choice; `onChange` receives the decoded
 * choice (a custom status carries its kind as `status`). `allLabel` adds a leading "all" option whose
 * choice is `null` (the list filter). The trigger names a custom status together with its built-in one.
 */
export function AssetStatusSelect({
  id,
  value,
  onChange,
  groups,
  allLabel,
  placeholder,
  disabled,
  invalid,
  className,
}: {
  id?: string;
  value: StatusChoice | null;
  onChange: (choice: StatusChoice | null) => void;
  groups: readonly StatusOptionGroup[];
  /** When set, a first option with this text stands for "no status filter" (`null`). */
  allLabel?: string;
  /** Shown while nothing is chosen (no `allLabel`, `value` null). */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const grouped = hasCustomStatuses(groups);
  const selected = value ? labelOfChoice(value, groups) : null;
  let trigger: ReactNode = undefined;
  if (value) {
    trigger = <OptionText status={value.status} label={selected} withKind />;
  } else if (allLabel) {
    trigger = allLabel;
  } else if (placeholder) {
    trigger = <span className="text-muted-foreground">{placeholder}</span>;
  }
  return (
    <Select
      value={value ? encodeStatusChoice(value) : "ALL"}
      onValueChange={(next) => {
        if (next === "ALL") return onChange(null);
        const choice = decodeStatusChoice(next, groups);
        if (choice) onChange(choice);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={cn("w-full", className)}
        aria-invalid={invalid || undefined}
      >
        <SelectValue>{trigger}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allLabel ? <SelectItem value="ALL">{allLabel}</SelectItem> : null}
        {groups.map((group, index) => (
          <SelectGroup key={group.status}>
            {grouped && (index > 0 || allLabel) ? <SelectSeparator /> : null}
            <SelectItem value={encodeStatusChoice({ status: group.status, labelId: null })}>
              <OptionText status={group.status} label={null} />
            </SelectItem>
            {group.labels.map((label) => (
              <SelectItem
                key={label.id}
                value={encodeStatusChoice({ status: group.status, labelId: label.id })}
                className="pl-5"
              >
                <OptionText status={group.status} label={label} />
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The grouped options as dropdown-menu items, for the row kebab, the detail header and the bulk action.
 * With `value` they are a radio group (the current choice checked); without, plain items (a bulk action
 * has no single current value). `onSelect` receives the decoded choice.
 */
export function AssetStatusMenuOptions({
  groups,
  value,
  onSelect,
}: {
  groups: readonly StatusOptionGroup[];
  value?: StatusChoice;
  onSelect: (choice: StatusChoice) => void;
}) {
  const grouped = hasCustomStatuses(groups);
  const options = groups.map((group, index) => (
    <Fragment key={group.status}>
      {grouped && index > 0 ? <DropdownMenuSeparator /> : null}
      {[null, ...group.labels].map((label) => {
        const choice: StatusChoice = { status: group.status, labelId: label?.id ?? null };
        const encoded = encodeStatusChoice(choice);
        const text = <OptionText status={group.status} label={label} />;
        const indent = label ? "pl-5" : undefined;
        return value ? (
          <DropdownMenuRadioItem key={encoded} value={encoded} className={indent}>
            {text}
          </DropdownMenuRadioItem>
        ) : (
          <DropdownMenuItem key={encoded} className={indent} onSelect={() => onSelect(choice)}>
            {text}
          </DropdownMenuItem>
        );
      })}
    </Fragment>
  ));
  if (!value) return <>{options}</>;
  return (
    <DropdownMenuRadioGroup
      value={encodeStatusChoice(value)}
      onValueChange={(next) => {
        const choice = decodeStatusChoice(next, groups);
        if (choice) onSelect(choice);
      }}
    >
      {options}
    </DropdownMenuRadioGroup>
  );
}
