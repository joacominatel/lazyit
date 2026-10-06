"use client";

import { CheckIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useNow, useTranslations } from "next-intl";
import { HelpTip } from "@/components/help-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useFormatters } from "@/lib/hooks/use-formatters";
import type { ActPreviewSection } from "@/lib/offboarding/summary";
import { cn } from "@/lib/utils";

/**
 * The right column of the Offboarding sheet (#1532): the optional handover act. A paper-like PREVIEW
 * of what the printed Return Act will carry — letterhead, date, title, person, the sections the act
 * settings and the per-row consumable choices keep, the handover note and the two signature lines —
 * that re-renders as the settings change; then the settings themselves, collapsed under "Customize
 * act" because a team sets them once.
 *
 * The preview is a summary, not a copy of the act page: each section lists a few rows and counts the
 * rest (`actPreviewSections`). It reuses the act's own message keys (`users.act.*`) so the words on
 * screen are the words on paper. The paper stays white in both themes — it depicts a printed sheet —
 * so its ink is black at fixed opacities rather than the theme's text tokens.
 *
 * Settings persistence is unchanged: the same app-level localStorage keys the act page reads
 * (`lib/offboarding/constants.ts`).
 */

export interface ActSettings {
  orgName: string;
  onOrgNameChange: (value: string) => void;
  message: string;
  onMessageChange: (value: string) => void;
  showAssets: boolean;
  onShowAssetsChange: (value: boolean) => void;
  showAccess: boolean;
  onShowAccessChange: (value: boolean) => void;
  showConsumables: boolean;
  onShowConsumablesChange: (value: boolean) => void;
}

const SECTION_TITLE: Record<ActPreviewSection["kind"], string> = {
  assets: "assetsToReturn",
  access: "accessRevoked",
  consumablesToReturn: "consumablesToReturn",
  consumablesDelivered: "consumablesDelivered",
};

/** One section of the paper: its heading, a few ruled lines, "+N more". */
function PaperSection({ section }: { section: ActPreviewSection }) {
  const ta = useTranslations("users.act");
  const t = useTranslations("users.offboarding.actPanel");

  const lines: { key: string; text: string; box: boolean }[] = (() => {
    switch (section.kind) {
      case "assets":
        return section.rows.map((asset) => ({
          key: asset.assignmentId,
          text:
            asset.assetTag ??
            asset.name ??
            (asset.resolved ? ta("assetFallback") : asset.assetId),
          box: true,
        }));
      case "access":
        return section.rows.map((grant) => ({
          key: grant.grantId,
          text:
            grant.appName ??
            (grant.resolved ? ta("applicationFallback") : grant.applicationId),
          box: false,
        }));
      default:
        return section.rows.map((row) => ({
          key: String(row.deliveryId),
          text: `${row.name} · ${
            section.kind === "consumablesToReturn" ? row.outstanding : row.quantity
          } ${row.unit}`,
          box: section.kind === "consumablesToReturn",
        }));
    }
  })();

  const empty =
    lines.length === 0 && section.more === 0
      ? section.kind === "assets"
        ? ta("nothingToReturn")
        : section.kind === "access"
          ? ta("noActiveAccess")
          : null
      : null;

  return (
    <div className="space-y-1">
      <p className="text-[9px] font-semibold tracking-[0.05em] text-black/55 uppercase">
        {ta(SECTION_TITLE[section.kind])}
      </p>
      {empty ? <p className="text-black/55">{empty}</p> : null}
      {lines.map((line) => (
        <p key={line.key} className="flex min-w-0 items-center gap-1.5">
          {/* The act's tick box for IT at handover — only on rows that come back. */}
          {line.box ? (
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-[2px] border border-black/50"
            />
          ) : null}
          <span className="truncate">{line.text}</span>
        </p>
      ))}
      {section.more > 0 ? (
        <p className="text-black/55">{t("more", { count: section.more })}</p>
      ) : null}
    </div>
  );
}

/** The live, paper-like preview of the printed act. */
function ActPaper({
  orgName,
  message,
  person,
  sections,
  isLoading,
  isError,
}: {
  orgName: string;
  message: string;
  person: { name: string; email: string };
  sections: ActPreviewSection[];
  isLoading: boolean;
  isError: boolean;
}) {
  const ta = useTranslations("users.act");
  const t = useTranslations("users.offboarding.actPanel");
  const { date } = useFormatters();
  // The same fixed "issued" instant the act page uses (next-intl's server-seeded `useNow()`, #1448),
  // so the preview never disagrees with the paper about the date and never shifts on re-render.
  const issuedAt = useNow().toISOString();

  return (
    <figure
      aria-label={t("previewLabel")}
      className="flex aspect-[4/5] flex-col gap-2.5 rounded-md bg-white p-4 text-[10.5px] leading-snug text-black/85 shadow-sm ring-1 ring-foreground/10"
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-black/20 pb-1.5 font-semibold">
        <span className="truncate">{orgName}</span>
        <span className="font-mono font-normal tabular-nums">{date(issuedAt)}</span>
      </div>
      <div>
        <p className="text-[13px] font-bold">{ta("titleEn")}</p>
        <p className="truncate text-black/55">
          {person.name} · {person.email}
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-2.5 w-1/3 bg-black/10" />
          <Skeleton className="h-2.5 w-2/3 bg-black/10" />
          <Skeleton className="h-2.5 w-1/2 bg-black/10" />
        </div>
      ) : isError ? (
        <p className="text-black/55">{t("unavailable")}</p>
      ) : (
        sections.map((section) => (
          <PaperSection key={section.kind} section={section} />
        ))
      )}

      {message.trim() ? (
        <p className="line-clamp-4 whitespace-pre-wrap text-black/70">{message}</p>
      ) : null}

      <div className="mt-auto grid grid-cols-2 gap-4 pt-3">
        {(["signatureEmployee", "signatureIt"] as const).map((key) => (
          <p key={key} className="border-t border-black/50 pt-1 text-black/55">
            {ta(key)}
          </p>
        ))}
      </div>
    </figure>
  );
}

/** An on/off chip for one act section — a real toggle button (`aria-pressed`). */
function ToggleChip({
  pressed,
  onPressedChange,
  children,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 transition-colors outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring",
        pressed
          ? "bg-foreground/5 font-medium text-foreground ring-foreground/30"
          : "text-muted-foreground ring-border hover:text-foreground",
      )}
    >
      {/* The check (not colour) carries the state, so it reads in both themes and without colour. */}
      <CheckIcon
        className={cn("size-3.5", pressed ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
      {children}
    </button>
  );
}

export function OffboardingActPanel({
  person,
  sections,
  isLoading,
  isError,
  settings,
}: {
  person: { name: string; email: string };
  sections: ActPreviewSection[];
  isLoading: boolean;
  isError: boolean;
  settings: ActSettings;
}) {
  const t = useTranslations("users.offboarding");
  return (
    <section aria-labelledby="offboarding-act-heading" className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <h3
          id="offboarding-act-heading"
          className="text-sm font-medium text-foreground"
        >
          {t("actPanel.title")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t("actPanel.optional")}
        </span>
      </div>

      <ActPaper
        orgName={settings.orgName}
        message={settings.message}
        person={person}
        sections={sections}
        isLoading={isLoading}
        isError={isError}
      />

      {/* Collapsed by default: a team sets the letterhead, note and sections once (localStorage v1). */}
      <details className="group rounded-lg bg-card ring-1 ring-foreground/10">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 select-none [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <span className="text-sm font-medium text-foreground">
            {t("customize.title")}
          </span>
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {t("customize.summary")}
          </span>
        </summary>
        <div className="space-y-3 px-3 pt-1 pb-3">
          <div className="space-y-1.5">
            <Label htmlFor="offboarding-org">{t("companyName")}</Label>
            <Input
              id="offboarding-org"
              value={settings.orgName}
              onChange={(e) => settings.onOrgNameChange(e.target.value)}
              placeholder={t("companyPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="offboarding-message">{t("handoverNote")}</Label>
              <HelpTip topic={t("handoverNote")}>
                <p>{t("handoverHelp")}</p>
              </HelpTip>
            </div>
            <Textarea
              id="offboarding-message"
              value={settings.message}
              onChange={(e) => settings.onMessageChange(e.target.value)}
              rows={3}
              className="text-sm"
              placeholder={t("handoverPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span
                id="offboarding-act-sections"
                className="text-sm leading-none font-medium"
              >
                {t("customize.include")}
              </span>
              <HelpTip topic={t("customize.include")}>
                <p>{t("printedActHelp")}</p>
              </HelpTip>
            </div>
            <div
              role="group"
              aria-labelledby="offboarding-act-sections"
              className="flex flex-wrap gap-1.5"
            >
              <ToggleChip
                pressed={settings.showAssets}
                onPressedChange={settings.onShowAssetsChange}
              >
                {t("customize.assets")}
              </ToggleChip>
              <ToggleChip
                pressed={settings.showAccess}
                onPressedChange={settings.onShowAccessChange}
              >
                {t("customize.access")}
              </ToggleChip>
              <ToggleChip
                pressed={settings.showConsumables}
                onPressedChange={settings.onShowConsumablesChange}
              >
                {t("customize.consumables")}
              </ToggleChip>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
