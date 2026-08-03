"use client";

import { ServerStackIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";

/**
 * The "no nodes yet" surface for the topology canvas (ADR-0070 §6).
 *
 * It used to carry no action at all, on the reasoning that the page header's "Add node" button was
 * always in view. #1181 changed what that button is: it now leads with installing a reporting agent,
 * and an empty map is the single moment an operator most needs to be told that path exists — the
 * whole ADR-0074 campaign built an agent that populates this map, and this is the screen where its
 * absence is most visible. So the caller passes the same affordance down and it renders here too.
 *
 * ponytail: reuses the app-wide `EmptyState` (inventory pillar, matching the Assets section) rather
 * than a bespoke canvas placeholder, and reuses the header's control rather than declaring a second
 * one — there is one add affordance on this screen, shown in two places.
 */
export function InfraEmptyState({ action }: { action?: React.ReactNode }) {
  const t = useTranslations("infra");
  return (
    <div className="flex size-full items-center justify-center">
      <EmptyState
        icon={ServerStackIcon}
        pillar="inventory"
        title={t("empty.title")}
        description={t("empty.description")}
        className="max-w-md"
      >
        {/* `children`, not `action`: the shared EmptyState's `action` prop is a single
            label+href/onClick pair, and this is a whole control with two paths behind it. */}
        {action ? <div className="mt-1">{action}</div> : null}
      </EmptyState>
    </div>
  );
}
