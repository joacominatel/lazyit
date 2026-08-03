"use client";

import { PlusIcon, ServerStackIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * The agent-onboarding section at the TOP of the Servers (Table) view (ADR-0074 §6, epic #831). The
 * CEO found the reporting-agent entry point undiscoverable, so this turns it into a guided hero:
 *
 *  - **No agents yet** (`hasAgents === false`): a prominent, friendly hero card explaining what a
 *    reporting agent is, with the primary **"Create your first agent"** CTA. This is the empty-state
 *    that gets a non-technical operator to their first agent without reading docs.
 *  - **Agents exist** (`hasAgents === true`): render nothing. It used to collapse to a quiet "Add
 *    agent" button here, which #1181 made redundant: the Topology page header now carries an add
 *    affordance that leads with the agent and is visible in BOTH views, so an onboarded estate would
 *    have shown the same action twice on the same screen. (The Pending review tray is separate and
 *    still renders.)
 *  - **While the estate's agent-status is still loading** (`hasAgents === undefined`): render nothing,
 *    so the hero never flashes in then collapses.
 *
 * `canMint` gates the create CTA on `settings:manage` — the gate on every `/service-accounts` route,
 * so on minting one (ADR-0048). Without it the hero shows a muted hint instead of a dead button.
 */
export function AgentOnboarding({
  canMint,
  hasAgents,
  onCreate,
}: {
  canMint: boolean;
  hasAgents: boolean | undefined;
  onCreate: () => void;
}) {
  const t = useTranslations("infra.onboarding");

  // Still resolving whether any agent exists — render nothing rather than flash the hero.
  if (hasAgents === undefined) return null;

  // Onboarded: nothing here. The page header's add affordance (#1181) is the one place to reach the
  // wizard from, in either view.
  if (hasAgents) return null;

  // Empty estate: the hero.
  return (
    <section className="rounded-xl border bg-card p-6 sm:p-8">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden
        >
          <ServerStackIcon className="size-6" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canMint ? (
          <Button size="lg" onClick={onCreate} className="shrink-0">
            <PlusIcon />
            {t("cta")}
          </Button>
        ) : (
          <p className="shrink-0 text-sm text-muted-foreground sm:max-w-[14rem]">
            {t("noPermissionHint")}
          </p>
        )}
      </div>
    </section>
  );
}
