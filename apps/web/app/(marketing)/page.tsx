import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  CubeIcon,
  KeyIcon,
  LockClosedIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { getConfigStatus } from "@/lib/api/endpoints/config";

import "./landing.css";
import {
  AccessFrame,
  AssetFrame,
  DashboardFrame,
  SecretFrame,
} from "./_components/landing-frames";

/**
 * Marketing landing (#602). Server component so it reads first-run state and picks the right
 * primary CTA: an UNCONFIGURED instance points operators at /setup; a configured one points at
 * the dashboard. All copy is localized through the `marketing` next-intl namespace (en/es).
 *
 * `force-dynamic`: first-run state is read per request — never frozen into a static prerender,
 * which would show the wrong CTA after first-run completes.
 *
 * The four pillars mirror the real product (docs/00-overview/vision.md). There is no Tickets
 * pillar — ticketing was decided OUT (CEO, 2026-06-16); see issue #603.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing");
  const locale = await getLocale();
  const title = t("meta.title");
  const description = t("meta.description");
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      siteName: "lazyit",
      locale,
    },
    twitter: { card: "summary", title, description },
  };
}

const GITHUB_URL = "https://github.com/joacominatel/lazyit";

const PILLARS: { key: string; icon: ComponentType<{ className?: string }>; chip: string }[] = [
  { key: "inventory", icon: CubeIcon, chip: "bg-pillar-inventory/10 text-pillar-inventory" },
  { key: "access", icon: KeyIcon, chip: "bg-pillar-access/10 text-pillar-access" },
  { key: "knowledge", icon: BookOpenIcon, chip: "bg-pillar-knowledge/10 text-pillar-knowledge" },
  { key: "manage", icon: UsersIcon, chip: "bg-pillar-manage/10 text-pillar-manage" },
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

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckIcon
        className="mt-0.5 size-4 shrink-0 text-pillar-knowledge"
        aria-hidden="true"
      />
      <span className="text-sm text-muted-foreground">{children}</span>
    </li>
  );
}

export default async function LandingPage() {
  const t = await getTranslations("marketing");
  const unconfigured = await instanceIsUnconfigured();

  const PrimaryCta = (
    <Button asChild size="lg">
      <Link href={unconfigured ? "/setup" : "/dashboard"}>
        {unconfigured ? t("hero.ctaSetup") : t("hero.ctaDashboard")}
        <ArrowRightIcon aria-hidden="true" />
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-1 flex-col">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div
          className="lz-grid pointer-events-none absolute inset-0 -z-10"
          aria-hidden="true"
        />
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-20 sm:py-24 lg:grid-cols-2 lg:py-28">
          <div className="flex animate-fade-in flex-col items-start gap-6">
            <span className="animate-rise-in inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground shadow-e1">
              <ShieldCheckIcon
                className="size-3.5 text-pillar-knowledge"
                aria-hidden="true"
              />
              {t("hero.badge")}
            </span>
            <h1 className="animate-rise-in text-[clamp(2.25rem,5vw,3.75rem)] leading-[1.05] font-semibold tracking-tight text-balance [animation-delay:60ms]">
              {t("hero.title")}
            </h1>
            <p className="animate-rise-in max-w-xl text-base text-pretty text-muted-foreground sm:text-lg [animation-delay:120ms]">
              {t("hero.subtitle")}
            </p>
            <div className="animate-rise-in flex flex-wrap items-center gap-3 [animation-delay:180ms]">
              {PrimaryCta}
              <Button asChild variant="outline" size="lg">
                <Link href="/login">{t("hero.ctaSignIn")}</Link>
              </Button>
            </div>
          </div>
          <div className="animate-rise-in lg:justify-self-end [animation-delay:240ms]">
            <AssetFrame className="w-full max-w-md" />
          </div>
        </div>
      </section>

      {/* ── Demo video ──────────────────────────────────────────────────── */}
      <section className="border-t border-border bg-muted/30">
        <div className="lz-reveal mx-auto w-full max-w-5xl px-6 py-20 sm:py-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {t("demo.title")}
          </h2>
          <p className="mt-4 max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
            {t("demo.subtitle")}
          </p>
          <div className="mt-10 overflow-hidden rounded-xl border border-border shadow-e2">
            {/* Native controls, no autoplay; `preload=metadata` avoids fetching the 10 MB file until
                play. Served from /public (allowed through the auth proxy — see proxy.ts isPublicPath). */}
            <video
              controls
              preload="metadata"
              playsInline
              className="aspect-video w-full bg-black"
            >
              <source src="/landing/demo.mp4" type="video/mp4" />
            </video>
          </div>
        </div>
      </section>

      {/* ── Thesis: asset-centric ───────────────────────────────────────── */}
      <section className="border-t border-border">
        <div className="lz-reveal mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {t("thesis.title")}
          </h2>
          <p className="mt-5 max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
            {t("thesis.body")}
          </p>
          <ul className="mt-8 grid gap-3 sm:grid-cols-3">
            <Bullet>{t("thesis.p1")}</Bullet>
            <Bullet>{t("thesis.p2")}</Bullet>
            <Bullet>{t("thesis.p3")}</Bullet>
          </ul>
        </div>
      </section>

      {/* ── Showcase: real product screens ──────────────────────────────── */}
      <section className="border-t border-border bg-muted/30">
        <div className="lz-reveal mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {t("showcase.title")}
          </h2>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            {t("showcase.subtitle")}
          </p>
          <div className="mt-10 grid items-start gap-6 lg:grid-cols-2">
            <DashboardFrame />
            <AccessFrame />
          </div>
        </div>
      </section>

      {/* ── Pillars ─────────────────────────────────────────────────────── */}
      <section className="border-t border-border">
        <div className="lz-reveal mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {t("pillars.title")}
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            {t("pillars.subtitle")}
          </p>
          <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {PILLARS.map(({ key, icon: Icon, chip }) => (
              <div key={key}>
                <span
                  className={`flex size-10 items-center justify-center rounded-lg ${chip}`}
                >
                  <Icon className="size-6" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-foreground">
                  {t(`pillars.${key}.name`)}
                </h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {t(`pillars.${key}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Secret Manager (zero-knowledge) ─────────────────────────────── */}
      <section className="border-t border-border bg-muted/30">
        <div className="lz-reveal mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-20 sm:py-24 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
              <LockClosedIcon
                className="size-3.5 text-pillar-access"
                aria-hidden="true"
              />
              {t("secrets.badge")}
            </span>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {t("secrets.title")}
            </h2>
            <p className="mt-5 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
              {t("secrets.body")}
            </p>
            <ul className="mt-8 space-y-3">
              <Bullet>{t("secrets.p1")}</Bullet>
              <Bullet>{t("secrets.p2")}</Bullet>
              <Bullet>{t("secrets.p3")}</Bullet>
            </ul>
          </div>
          <div className="lg:justify-self-end">
            <SecretFrame className="w-full max-w-md" />
          </div>
        </div>
      </section>

      {/* ── Self-host ───────────────────────────────────────────────────── */}
      <section className="border-t border-border">
        <div className="lz-reveal mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-20 sm:py-24 lg:grid-cols-2">
          <div>
            <span className="flex size-10 items-center justify-center rounded-lg bg-pillar-inventory/10 text-pillar-inventory">
              <ServerStackIcon className="size-6" aria-hidden="true" />
            </span>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {t("selfhost.title")}
            </h2>
            <p className="mt-5 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
              {t("selfhost.body")}
            </p>
            <ul className="mt-8 space-y-3">
              <Bullet>{t("selfhost.p1")}</Bullet>
              <Bullet>{t("selfhost.p2")}</Bullet>
              <Bullet>{t("selfhost.p3")}</Bullet>
            </ul>
          </div>
          <div className="dark rounded-xl bg-card p-5 font-mono text-sm shadow-e2 ring-1 ring-border lg:justify-self-end lg:w-full lg:max-w-md">
            <p className="text-card-foreground">
              <span className="text-muted-foreground select-none">$ </span>
              {t("selfhost.command")}
            </p>
            <p className="mt-3 flex items-center gap-2 text-success">
              <CheckIcon className="size-4" aria-hidden="true" />
              lazyit running on :3000
            </p>
          </div>
        </div>
      </section>

      {/* ── CTA band ────────────────────────────────────────────────────── */}
      <section className="border-t border-border">
        <div className="lz-reveal mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center sm:py-28">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {t("cta.title")}
          </h2>
          <p className="max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
            {t("cta.body")}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {PrimaryCta}
            <Button asChild variant="outline" size="lg">
              <Link href="/help">{t("cta.secondary")}</Link>
            </Button>
          </div>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("nav.github")} ↗
          </a>
        </div>
      </section>
    </div>
  );
}
