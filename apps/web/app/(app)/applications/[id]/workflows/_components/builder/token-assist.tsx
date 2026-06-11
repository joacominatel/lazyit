"use client";

import { PlusIcon } from "@heroicons/react/24/outline";
import type { WorkflowStep } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ContextTokenGroup } from "@/lib/workflow/context-tokens";
import { buildContextTokens } from "@/lib/workflow/context-tokens";
import {
  groupTokens,
  parseTemplate,
  wrapToken,
} from "@/lib/workflow/template";
import { cn } from "@/lib/utils";

/**
 * Shared token-assist primitives for the workflow builder (issues #337 path field, #338 body composer,
 * #339 advanced editor share the same token source — `buildContextTokens`, scoped to PRIOR steps).
 *
 * SEC-A5: every value rendered here is admin-authored template text or a context-token PATH (never a
 * resolved runtime value) — and it is always rendered as escaped React text, never raw-HTML injection.
 * The `no-unsafe-html.test.ts` guard enforces this for the whole subtree.
 */

/**
 * Render a template string with its `{{ token }}` spans visually distinguished from literal text — the
 * "highlight `{{ token }}` spans" requirement (#337). A malformed/unknown token is still highlighted;
 * the surrounding validation (`validateTemplate`) is what colours the warning, not this renderer.
 */
export function TokenHighlight({
  template,
  className,
}: {
  template: string;
  className?: string;
}) {
  const segments = useMemo(() => parseTemplate(template), [template]);
  return (
    <span className={cn("font-mono text-xs break-all", className)}>
      {segments.map((segment, i) =>
        segment.type === "token" ? (
          <span
            key={`t-${i}-${segment.raw}`}
            className="rounded bg-primary/10 px-1 text-primary ring-1 ring-primary/20"
          >
            {`{{ ${segment.raw} }}`}
          </span>
        ) : (
          <span key={`l-${i}-${segment.text}`}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

/** The i18n group order the picker renders sections in (matches the catalog's natural order). */
const GROUP_ORDER: ContextTokenGroup[] = [
  "event",
  "grantee",
  "application",
  "grant",
  "steps",
];

/**
 * A popover that lists the available context tokens (grouped + searchable) and calls `onInsert` with
 * the chosen `{{ path }}` string. The token source is `buildContextTokens(priorSteps)` — scoped to
 * PRIOR steps only, so a step never references its own or a later step's output (#337 / frontend.md §5a).
 */
export function TokenPicker({
  priorSteps = [],
  onInsert,
  triggerLabel,
  triggerClassName,
}: {
  priorSteps?: readonly WorkflowStep[];
  onInsert: (token: string) => void;
  /** Optional label for the trigger button; defaults to the "Insert token" copy. */
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const t = useTranslations("workflow");
  const [open, setOpen] = useState(false);

  const grouped = useMemo(
    () => groupTokens(buildContextTokens(priorSteps)),
    [priorSteps],
  );

  function handleInsert(path: string) {
    onInsert(wrapToken(path));
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("shrink-0", triggerClassName)}
        >
          <PlusIcon />
          {triggerLabel ?? t("token.insert")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={t("token.search")} />
          <CommandList>
            <CommandEmpty>{t("token.empty")}</CommandEmpty>
            {GROUP_ORDER.filter((group) => grouped.has(group)).map((group) => (
              <CommandGroup key={group} heading={t(`tokenGroup.${group}`)}>
                {(grouped.get(group) ?? []).map((token) => (
                  <CommandItem
                    key={token.path}
                    // cmdk matches on `value` — include both the dotted path and the human label so
                    // typing "email" or "First name" both surface the row.
                    value={`${token.path} ${token.label}`}
                    onSelect={() => handleInsert(token.path)}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-xs text-primary">
                        {token.path}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {token.label}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
