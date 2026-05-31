import {
  BookOpenIcon,
  KeyIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";

const PILLARS: {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  {
    title: "Inventory",
    description:
      "Asset-centric tracking with full ownership history, plus consumable stock.",
    icon: ServerStackIcon,
  },
  {
    title: "Access",
    description:
      "Application access grants — who can reach what, granted and revoked with a trail.",
    icon: KeyIcon,
  },
  {
    title: "Knowledge",
    description:
      "A lightweight, searchable knowledge base for runbooks and how-tos.",
    icon: BookOpenIcon,
  },
];

export default function LandingPage() {
  return (
    <section className="flex flex-1 flex-col items-center gap-10 px-6 py-24 text-center">
      <div className="flex flex-col items-center gap-6">
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          Self-hosted · no telemetry
        </span>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          IT management for small teams, without the enterprise bloat.
        </h1>
        <p className="max-w-xl text-pretty text-muted-foreground">
          Asset inventory, application access and a knowledge base — three
          pillars, asset-centric and opinionated. You run it; your data stays
          yours.
        </p>
      </div>
      <div className="grid w-full max-w-3xl gap-4 text-left sm:grid-cols-3">
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
