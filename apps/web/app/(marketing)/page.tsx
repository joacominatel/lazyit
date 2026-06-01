import {
  ArchiveBoxIcon,
  BookOpenIcon,
  ComputerDesktopIcon,
  KeyIcon,
  TicketIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import type { ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { getConfigStatus } from "@/lib/api/endpoints/config";

/**
 * Marketing landing. Server component so it can read first-run state and pick the right primary CTA:
 * an UNCONFIGURED instance points operators at /setup ("Set up lazyit"); a configured one points at
 * the dashboard. The five product pillars mirror the real product (ADR-0043 / docs/00-overview).
 *
 * `force-dynamic`: first-run state is read per request (never baked into a static prerender, which
 * would freeze the build-time config state and show the wrong CTA after first-run completes).
 */
export const dynamic = "force-dynamic";

const PILLARS: {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  {
    title: "Assets",
    description:
      "Asset-centric inventory with full, timestamped ownership history — assets persist, people rotate.",
    icon: ComputerDesktopIcon,
  },
  {
    title: "Access",
    description:
      "Application access grants — who can reach what, granted and revoked with an audit trail.",
    icon: KeyIcon,
  },
  {
    title: "Tickets",
    description:
      "Lightweight ticketing to track requests and incidents, tied back to the assets they touch.",
    icon: TicketIcon,
  },
  {
    title: "Consumables",
    description:
      "Stock levels for the things you hand out, with an append-only movement ledger.",
    icon: ArchiveBoxIcon,
  },
  {
    title: "Knowledge",
    description:
      "A searchable, versioned knowledge base for runbooks and how-tos.",
    icon: BookOpenIcon,
  },
];

/** First-run check for the primary CTA; fail safe to "configured" (Dashboard) if the API is down. */
async function instanceIsUnconfigured(): Promise<boolean> {
  try {
    const status = await getConfigStatus();
    return status.isConfigured === false;
  } catch {
    return false;
  }
}

export default async function LandingPage() {
  const unconfigured = await instanceIsUnconfigured();

  return (
    <section className="flex flex-1 flex-col items-center gap-10 px-6 py-24 text-center">
      <div className="flex flex-col items-center gap-6">
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          Self-hosted · no telemetry
        </span>
        <p className="font-mono text-sm font-semibold tracking-tight text-muted-foreground">
          lazyit
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          IT management for small teams, without the enterprise bloat.
        </h1>
        <p className="max-w-xl text-pretty text-muted-foreground">
          Asset inventory, application access, tickets, consumables and a
          knowledge base — asset-centric and opinionated. You run it; your data
          stays yours.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {unconfigured ? (
            <Button asChild>
              <Link href="/setup">Set up lazyit</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
      <div className="grid w-full max-w-4xl gap-4 text-left sm:grid-cols-2 lg:grid-cols-3">
        {PILLARS.map(({ title, description, icon: Icon }) => (
          <div
            key={title}
            className="rounded-xl border border-border bg-card p-5"
          >
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" />
            </div>
            <h2 className="mt-3 text-sm font-medium">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
