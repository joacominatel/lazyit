"use client";

import {
  BoltIcon,
  CpuChipIcon,
  GlobeAltIcon,
  HandRaisedIcon,
  PlusIcon,
  PuzzlePieceIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StepKind } from "@/lib/workflow/step-form";

interface PaletteEntry {
  kind: StepKind;
  icon: ComponentType<{ className?: string }>;
  /** Category label key under `workflow.palette.categories`. */
  categoryKey: string;
}

/** The v1 step types, grouped by category (frontend.md §3c). */
const V1_ENTRIES: PaletteEntry[] = [
  { kind: "REST", icon: GlobeAltIcon, categoryKey: "apiHttp" },
  { kind: "WEBHOOK_OUT", icon: BoltIcon, categoryKey: "webhooks" },
  { kind: "MANUAL", icon: HandRaisedIcon, categoryKey: "humanTasks" },
];

/** The reserved, not-yet-shipped tiers — rendered greyed as explicit "coming soon", never pickable. */
const COMING_SOON: { icon: ComponentType<{ className?: string }>; labelKey: string }[] =
  [
    { icon: PuzzlePieceIcon, labelKey: "sdk" },
    { icon: CpuChipIcon, labelKey: "mcp" },
  ];

/**
 * The category-organized "Add step" palette (frontend.md §3c). Groups the v1 step types by what they do
 * (API/HTTP · Webhooks · Human tasks) and greys the reserved SDK/MCP tiers as "coming soon" — the
 * operator sees the roadmap without being able to pick a dead option. The discriminated-union step
 * schema makes a later type an additive variant, not a rewrite.
 */
export function StepPalette({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const t = useTranslations("workflow");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <PlusIcon />
          {t("palette.addStep")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {V1_ENTRIES.map(({ kind, icon: Icon, categoryKey }) => (
          <DropdownMenuItem key={kind} onSelect={() => onAdd(kind)}>
            <Icon />
            <span className="flex flex-col">
              <span>{t(`kind.${kind}`)}</span>
              <span className="text-xs text-muted-foreground">
                {t(`palette.categories.${categoryKey}`)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("palette.comingSoon")}
        </DropdownMenuLabel>
        {COMING_SOON.map(({ icon: Icon, labelKey }) => (
          <DropdownMenuItem key={labelKey} disabled className="opacity-60">
            <Icon />
            {t(`palette.${labelKey}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
