"use client";

import {
  ChevronDownIcon,
  PencilSquareIcon,
  PlusIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { addNodeOptions, type AddNodeOption } from "./add-node-options";

/**
 * The Topology screen's "add" affordance (issue #1181).
 *
 * The Map — the view the topology exists for, and where an operator goes to notice what is missing —
 * used to offer exactly one path: the hand-drawn node. The wizard that mints the reporting agent's
 * Service Account lived only in the Table view, behind a `?view=` switch nothing signposted, which
 * made the headline feature of the whole ADR-0074 campaign reachable only by accident.
 *
 * Both paths now sit on one control, and the agent leads — see {@link addNodeOptions} for why that
 * order is a product decision rather than a layout one. Neither dialog is reimplemented here; this
 * only opens the two that already exist, so the platform switch, the unsigned-executable warning and
 * the token-shown-once lock stay in the one place they are maintained.
 *
 * With only one path available the control collapses to a plain button for it — a dropdown of one is
 * a click tax, and a menu entry an operator's permissions forbid teaches them nothing.
 */
export function AddNodeMenu({
  canCreateAgent,
  canCreateManual,
  onCreateAgent,
  onCreateManual,
}: {
  /** `settings:manage` — required to mint the agent's Service Account (ADR-0074 §6 / ADR-0048). */
  canCreateAgent: boolean;
  /** `infra:manage` — required to put a node on the map. */
  canCreateManual: boolean;
  onCreateAgent: () => void;
  onCreateManual: () => void;
}) {
  const t = useTranslations("infra.add");
  const options = addNodeOptions({ canCreateAgent, canCreateManual });
  if (options.length === 0) return null;

  const run = (option: AddNodeOption) =>
    option === "agent" ? onCreateAgent() : onCreateManual();

  if (options.length === 1) {
    const only = options[0];
    return (
      <Button onClick={() => run(only)}>
        {only === "agent" ? <ServerStackIcon /> : <PlusIcon />}
        {t(only === "agent" ? "agentLabel" : "manualLabel")}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <PlusIcon />
          {t("action")}
          <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* Wide enough for the one-line reason under each item. The reasons are the point: an operator
          choosing between these two is choosing between an inventory that maintains itself and one
          that is accurate for as long as someone remembers to edit it, and the labels alone do not
          say that. */}
      <DropdownMenuContent align="end" className="max-w-[22rem] min-w-[18rem]">
        <DropdownMenuItem
          className="items-start gap-3 px-2 py-2.5"
          onSelect={onCreateAgent}
        >
          <ServerStackIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t("agentLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("agentDescription")}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start gap-3 px-2 py-2.5"
          onSelect={onCreateManual}
        >
          <PencilSquareIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t("manualLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("manualDescription")}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
