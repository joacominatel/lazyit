"use client";

import {
  BookOpenIcon,
  CheckCircleIcon,
  DocumentMagnifyingGlassIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  LinkIcon,
  ServerIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import type { AiSettings } from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ComponentType, ReactNode } from "react";
import { Callout } from "@/components/callout";
import { HelpTip } from "@/components/help-tip";
import { PageHeader } from "@/components/page-header";
import { useRecordTab } from "@/components/record-page";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, StatusDot } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAiConfig } from "@/lib/api/hooks/use-ai-config";
import { cn } from "@/lib/utils";
import { AdminGate } from "../../_components/admin-gate";
import { AI_TABS, type AiTab, aiStatusTiles } from "../_lib/ai-status";
import { AiConnectionEditor } from "./ai-connection-editor";
import { AiDangerZone } from "./ai-danger-zone";
import { AiDocumentExtractionSection } from "./ai-document-extraction-section";
import { AiLimitsEditor } from "./ai-limits-editor";
import { AiMcpSection } from "./ai-mcp-section";
import { AiSetupWizard } from "./ai-setup-wizard";
import { AiWebSearchSection } from "./ai-web-search-section";

/**
 * Settings → AI body (client; ADR-0097, docs/ai-assistant/frontend.md §5.1, §5.3). One read —
 * `GET /config/ai`, prefetched by the page — drives everything.
 *
 * Status tiles + tabs (#1540; ledger-design-language §4c): four tiles say at a glance what is on —
 * Provider, Web search, Document reading, External agents (with the allowed-client count) — and each
 * opens its tab. The tabs, in `?tab=`:
 *   - Connection   — the setup wizard while the assistant is OFF (a saved draft resumes where it
 *                    stopped), the provider & model editor and the danger zone while it is ON;
 *   - Limits       — behaviour & limits;
 *   - Capabilities — web search (#1389) and purchase document extraction (#1477), each switch asking
 *                    for consent with the full "What leaves lazyit" disclosure when turned on;
 *   - External agents — MCP and its allowed clients (independent of the provider).
 * `AdminGate` hides the page from callers without `settings:manage`; the API is the real gate.
 */
export function AiSettingsView({ justEnabled }: { justEnabled: boolean }) {
  const t = useTranslations("aiSettings");
  const tCommon = useTranslations("common");
  const { data: settings, isLoading, isError, error, refetch } = useAiConfig();

  return (
    <AdminGate>
      <div className="space-y-5">
        <PageHeader
          title={t("page.title")}
          subtitle={t("page.subtitle")}
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href={t("links.setup")} prefetch={false} target="_blank" rel="noopener">
                <BookOpenIcon />
                {t("page.manualLink")}
                <span className="sr-only">{tCommon("helpTip.newTab")}</span>
              </Link>
            </Button>
          }
          badge={
            settings ? (
              <StatusBadge tone={settings.enabled ? "success" : "neutral"}>
                {settings.enabled ? t("page.statusOn") : t("page.statusOff")}
              </StatusBadge>
            ) : undefined
          }
        />

        {isLoading ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {AI_TABS.map((tab) => (
                <Skeleton key={tab} className="h-[4.5rem] rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : isError || !settings ? (
          <ErrorState title={t("page.loadError")} onRetry={() => refetch()} error={error} />
        ) : (
          <AiSettingsBody settings={settings} justEnabled={justEnabled} />
        )}
      </div>
    </AdminGate>
  );
}

/**
 * Every tab stays mounted and the inactive ones are hidden, so switching tabs never drops a half-filled
 * form (the wizard's step, an unsaved limit) — the page held all of them at once before the tabs.
 */
const PANEL = "space-y-4 data-[state=inactive]:hidden";

function AiSettingsBody({ settings, justEnabled }: { settings: AiSettings; justEnabled: boolean }) {
  const t = useTranslations("aiSettings");
  const [tab, setTab] = useRecordTab<AiTab>(AI_TABS, "connection");
  const tiles = aiStatusTiles(settings);

  return (
    <>
      {justEnabled && settings.enabled ? (
        <Callout tone="success" icon={<CheckCircleIcon />} role="status">
          <p className="text-sm font-medium">{t("page.enabled.title")}</p>
          <p className="text-sm">{t("page.enabled.body")}</p>
        </Callout>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatusTile
          icon={SparklesIcon}
          label={t("tiles.provider")}
          active={tab === "connection"}
          onSelect={() => setTab("connection")}
          value={tiles.provider.label ?? t("tiles.notConfigured")}
          state={tiles.provider.state === "on"}
          extra={
            tiles.provider.state !== "on" ? (
              <StatusBadge tone="warning">
                {tiles.provider.state === "draft" ? t("tiles.draft") : t("tiles.missing")}
              </StatusBadge>
            ) : undefined
          }
        />
        <StatusTile
          icon={GlobeAltIcon}
          label={t("tiles.webSearch")}
          active={tab === "capabilities"}
          onSelect={() => setTab("capabilities")}
          value={tiles.webSearch ? t("page.statusOn") : t("page.statusOff")}
          state={tiles.webSearch}
        />
        <StatusTile
          icon={DocumentMagnifyingGlassIcon}
          label={t("tiles.documents")}
          active={tab === "capabilities"}
          onSelect={() => setTab("capabilities")}
          value={tiles.documents ? t("page.statusOn") : t("page.statusOff")}
          state={tiles.documents}
        />
        <StatusTile
          icon={LinkIcon}
          label={t("tiles.agents")}
          active={tab === "agents"}
          onSelect={() => setTab("agents")}
          value={t("tiles.agentsValue", {
            state: tiles.agents.on ? t("page.statusOn") : t("page.statusOff"),
            count: tiles.agents.clients,
          })}
          state={tiles.agents.on}
        />
      </div>

      {!settings.keyConfigured ? (
        <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
          <p className="flex flex-wrap items-center gap-1 text-sm font-medium">
            {t("page.secretKey.title")}
            <HelpTip topic={t("page.secretKey.title")} href={t("links.secretKey")}>
              <p>{t("page.secretKey.body")}</p>
              <p>{t("page.secretKey.help")}</p>
            </HelpTip>
          </p>
        </Callout>
      ) : null}

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList aria-label={t("tabs.label")}>
          {AI_TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="connection" forceMount className={PANEL}>
          {settings.enabled ? (
            <AiConnectionEditor settings={settings} />
          ) : (
            <AiSetupWizard settings={settings} />
          )}
          {settings.enabled ? <AiDangerZone settings={settings} /> : null}
        </TabsContent>

        <TabsContent value="limits" forceMount className={PANEL}>
          <AiLimitsEditor settings={settings} />
        </TabsContent>

        <TabsContent value="capabilities" forceMount className={PANEL}>
          <AiWebSearchSection settings={settings} />
          <AiDocumentExtractionSection settings={settings} />
        </TabsContent>

        <TabsContent value="agents" forceMount className={PANEL}>
          <AiMcpSection settings={settings} />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ServerIcon className="size-4 shrink-0" aria-hidden />
            <span>
              {t("page.serviceAccounts.body")}{" "}
              <Link
                href="/settings/service-accounts"
                className="font-medium text-foreground underline underline-offset-4"
              >
                {t("page.serviceAccounts.link")}
              </Link>
            </span>
          </p>
        </TabsContent>
      </Tabs>
    </>
  );
}

/** One status tile: what it is, its state, and a click that opens its tab. */
function StatusTile({
  icon: Icon,
  label,
  value,
  state,
  extra,
  active,
  onSelect,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  /** On (green dot) or off (neutral dot). */
  state: boolean;
  extra?: ReactNode;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-3 text-left ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
        active && "ring-2 ring-primary/60",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        {label}
      </span>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <StatusDot tone={state ? "success" : "neutral"} />
          <span className="truncate">{value}</span>
        </span>
        {extra}
      </span>
    </button>
  );
}
