import {
  ArrowRightIcon,
  BookOpenIcon,
  KeyIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Dashboard landing. Static, by design — it frames lazyit's three pillars
 * (Inventory / Access / Knowledge) and links straight into each area. Live
 * metrics (counts, low-stock, expiring grants) are a separate PR once a metrics
 * endpoint exists; this view never calls the API.
 */
type Pillar = {
  title: string;
  description: string;
  href: string;
  cta: string;
  icon: ComponentType<{ className?: string }>;
};

const PILLARS: Pillar[] = [
  {
    title: "Inventory",
    description:
      "Track every asset and consumable — what you own, where it lives and who holds it now.",
    href: "/assets",
    cta: "Browse assets",
    icon: ServerStackIcon,
  },
  {
    title: "Access",
    description:
      "Manage application access grants: who can reach which app, granted and revoked with a full trail.",
    href: "/applications",
    cta: "Manage access",
    icon: KeyIcon,
  },
  {
    title: "Knowledge",
    description:
      "Write and find runbooks, how-tos and references in a lightweight, searchable knowledge base.",
    href: "/kb",
    cta: "Open the knowledge base",
    icon: BookOpenIcon,
  },
];

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your IT estate across three pillars — Inventory, Access and Knowledge.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PILLARS.map(({ title, description, href, cta, icon: Icon }) => (
          <Link
            key={title}
            href={href}
            className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="h-full transition-all group-hover:ring-primary/40">
              <CardHeader>
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" />
                </div>
                <CardTitle className="pt-2">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-1.5 text-sm font-medium text-primary">
                {cta}
                <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
