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
 * How each add path presents itself — the single table every branch below reads.
 *
 * It exists so the rendered order comes from {@link addNodeOptions} rather than from JSX. Writing the
 * two menu items out by hand would look identical on screen while quietly cutting the planner out of
 * the decision, and the unit test that pins the agent-first order would have gone on passing over a
 * menu whose markup said otherwise. That order is a product call, so it gets exactly one place that
 * can express it.
 */
const OPTION_PRESENTATION: Record<
  AddNodeOption,
  { Icon: typeof ServerStackIcon; labelKey: string; descriptionKey: string }
> = {
  agent: {
    Icon: ServerStackIcon,
    labelKey: "agentLabel",
    descriptionKey: "agentDescription",
  },
  manual: {
    Icon: PencilSquareIcon,
    labelKey: "manualLabel",
    descriptionKey: "manualDescription",
  },
};

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
  /** `settings:manage` — the gate on every `/service-accounts` route, so on minting one (ADR-0048). */
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
    const { Icon, labelKey } = OPTION_PRESENTATION[only];
    return (
      <Button onClick={() => run(only)}>
        <Icon />
        {t(labelKey)}
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
        {options.map((option) => {
          const { Icon, labelKey, descriptionKey } = OPTION_PRESENTATION[option];
          return (
            <DropdownMenuItem
              key={option}
              className="items-start gap-3 px-2 py-2.5"
              onSelect={() => run(option)}
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{t(labelKey)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(descriptionKey)}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
