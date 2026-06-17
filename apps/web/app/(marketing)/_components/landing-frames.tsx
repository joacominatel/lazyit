import {
  ArrowRightIcon,
  CheckIcon,
  LockClosedIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Product imagery for the landing, built BY HAND from the real design system — not stock art or
 * screenshots. Each frame is a faithful depiction of lazyit's own UI: an honest preview that stays
 * on-brand (bone + indigo, warm elevation) instead of a raw capture with the app's own chrome.
 *
 * Each frame forces a `dark` subtree so the `.dark` token values apply regardless of the page
 * theme — a floating dark "app window" on the bone canvas.
 */
function ProductFrame({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "dark relative isolate overflow-hidden rounded-2xl bg-card text-card-foreground shadow-e3 ring-1 ring-border",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/20" />
        <span className="size-2.5 rounded-full bg-muted-foreground/15" />
        <span className="ml-2 truncate font-mono text-xs text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

/** Faithful asset-detail depiction: tag + status, owner, and the ownership timeline. */
export async function AssetFrame({ className }: { className?: string }) {
  const t = await getTranslations("marketing.frames.asset");
  const events: { label: string; time: string; tone: "neutral" | "assign" | "release" }[] = [
    { label: t("ev1"), time: t("t1"), tone: "neutral" },
    { label: t("ev2"), time: t("t2"), tone: "assign" },
    { label: t("ev3"), time: t("t3"), tone: "release" },
    { label: t("ev4"), time: t("t4"), tone: "assign" },
  ];
  const dot = {
    neutral: "bg-muted-foreground/50",
    assign: "bg-success",
    release: "bg-warning",
  };

  return (
    <ProductFrame label={`lazyit / assets / ${t("tag")}`} className={className}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-lg font-semibold tracking-tight">
            {t("tag")}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {t("model")}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-success px-1.5 py-0.5 text-[0.7rem] font-medium text-success-foreground">
          <span className="size-1.5 rounded-full bg-success-foreground/80" />
          {t("status")}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-chart-1 text-[0.7rem] font-semibold text-white">
          DF
        </span>
        <span className="text-sm text-card-foreground">{t("ownerLine")}</span>
      </div>

      <p className="mt-5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("activityTitle")}
      </p>
      <ol className="relative mt-3 space-y-3 pl-5">
        <span className="absolute top-1.5 bottom-1.5 left-[5px] w-px bg-border" />
        {events.map((e, i) => (
          <li key={i} className="relative flex items-center justify-between gap-3">
            <span
              className={cn(
                "absolute top-1/2 left-[-20px] size-2.5 -translate-y-1/2 rounded-full ring-4 ring-card",
                dot[e.tone],
              )}
            />
            <span className="text-sm text-card-foreground">{e.label}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {e.time}
            </span>
          </li>
        ))}
      </ol>
    </ProductFrame>
  );
}

/** Faithful Secret-Manager depiction: a vault with masked items, sealed client-side. */
export async function SecretFrame({ className }: { className?: string }) {
  const t = await getTranslations("marketing.frames.secret");
  const items = [t("item1"), t("item2"), t("item3")];

  return (
    <ProductFrame label="lazyit / secrets" className={className}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-pillar-access/15 text-pillar-access">
          <LockClosedIcon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-card-foreground">
            {t("vault")}
          </p>
          <p className="truncate text-xs text-muted-foreground">{t("meta")}</p>
        </div>
      </div>

      <ul className="mt-4 space-y-2">
        {items.map((name) => (
          <li
            key={name}
            className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
          >
            <span className="truncate font-mono text-xs text-card-foreground">
              {name}
            </span>
            <span className="flex items-center gap-2">
              <span
                className="font-mono text-xs tracking-widest text-muted-foreground"
                aria-hidden="true"
              >
                ••••••••
              </span>
              <LockClosedIcon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center gap-1.5 text-xs text-success">
        <ShieldCheckIcon className="size-4" aria-hidden="true" />
        <span>{t("locked")}</span>
        <CheckIcon className="size-3.5" aria-hidden="true" />
      </div>
    </ProductFrame>
  );
}

/** Faithful dashboard depiction: headline counts + an assets-by-status bar. */
export async function DashboardFrame({ className }: { className?: string }) {
  const t = await getTranslations("marketing.frames.dashboard");
  const stats: { label: string; value: string; accent?: boolean }[] = [
    { label: t("assets"), value: "29" },
    { label: t("assigned"), value: "14" },
    { label: t("grants"), value: "19" },
    { label: t("lowStock"), value: "2", accent: true },
  ];
  // Illustrative split of the 29 assets by status (see the seeded dashboard summary).
  const bar: { tone: string; pct: number; label?: string }[] = [
    { tone: "bg-success", pct: 79, label: t("operational") },
    { tone: "bg-warning", pct: 10, label: t("maintenance") },
    { tone: "bg-info", pct: 7, label: t("storage") },
    { tone: "bg-muted-foreground/40", pct: 4 },
  ];

  return (
    <ProductFrame label="lazyit / dashboard" className={className}>
      <div className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg bg-muted px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p
              className={cn(
                "mt-0.5 font-mono text-xl font-semibold tracking-tight",
                s.accent ? "text-warning" : "text-card-foreground",
              )}
            >
              {s.value}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("byStatus")}
      </p>
      <div className="mt-2.5 flex h-2 overflow-hidden rounded-full">
        {bar.map((seg, i) => (
          <span key={i} className={seg.tone} style={{ width: `${seg.pct}%` }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {bar
          .filter((s) => s.label)
          .map((s) => (
            <span
              key={s.label}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span className={cn("size-2 rounded-full", s.tone)} />
              {s.label}
            </span>
          ))}
      </div>
    </ProductFrame>
  );
}

/** Faithful access depiction: who can reach which application, at what level. */
export async function AccessFrame({ className }: { className?: string }) {
  const t = await getTranslations("marketing.frames.access");
  const grants: { initials: string; name: string; app: string; level: string; avatar: string }[] = [
    { initials: "AG", name: "Ana Gómez", app: "GitHub", level: "admin", avatar: "bg-chart-1" },
    { initials: "MS", name: "Martín Suárez", app: "AWS", level: "admin", avatar: "bg-chart-2" },
    { initials: "DF", name: "Diego Fernández", app: "Jira", level: "developer", avatar: "bg-chart-3" },
    { initials: "CR", name: "Carla Ruiz", app: "1Password", level: "member", avatar: "bg-chart-5" },
  ];

  return (
    <ProductFrame label="lazyit / access" className={className}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("title")}
      </p>
      <ul className="mt-3 space-y-2.5">
        {grants.map((g) => (
          <li key={g.name} className="flex items-center gap-2.5">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white",
                g.avatar,
              )}
            >
              {g.initials}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
              {g.name}
              <ArrowRightIcon
                className="mx-1.5 inline size-3 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="text-muted-foreground">{g.app}</span>
            </span>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-card-foreground">
              {g.level}
            </span>
          </li>
        ))}
      </ul>
    </ProductFrame>
  );
}
