"use client";

import { ArrowTopRightOnSquareIcon, GlobeAltIcon } from "@heroicons/react/24/outline";
import type { AiSettings } from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { CopyButton } from "@/components/copy-button";
import { HelpTip } from "@/components/help-tip";
import { SettingLabel, SettingRow, SettingsSection } from "@/components/settings-section";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import { McpInstallPanel } from "@/app/(app)/account/ai/_components/mcp-install-panel";
import { useAiStatus } from "@/lib/api/hooks/use-ai-status";
import {
  buildUpdate,
  mcpConnectionMode,
  mcpEndpoint,
} from "../_lib/ai-settings-form";
import { AiErrorNotice } from "./ai-error-notice";
import { AiMcpAllowlistEditor } from "./ai-mcp-allowlist-editor";

const noSubscribe = () => () => {};

/** The page's own location, read after hydration (null on the server). */
function useLocationPart(part: "origin" | "protocol"): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location[part],
    () => null,
  );
}

/**
 * Settings → AI → External agents (ADR-0097; frontend.md §5.3; mcp-and-oauth.md §8, §14). The MCP switch
 * is independent of the LLM provider — MCP works with no provider configured. The section reads how
 * clients authenticate on THIS instance from `/ai/status` (`mcp.auth`) and says it in one line: OAuth
 * sign-in on an HTTPS instance; personal tokens on a plain-HTTP `lan` instance, where OAuth cannot work —
 * the details, including the internal-CA and cloud-connector traps, sit in its "?" tip. The endpoint is
 * `/ai/status` `mcp.endpoint` (the API's pinned `WEB_ORIGIN` + `/mcp`); only when the server has none is
 * the page's own origin shown, with a note. The install panel itself lives on `/account/ai` (W3-9); the
 * section embeds the same `McpInstallPanel` while `mcp.available`. The allowed-clients editor follows as
 * its own section.
 */
export function AiMcpSection({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.mcp");
  const tLinks = useTranslations("aiSettings.links");
  const save = useAiConfigSave();
  const status = useAiStatus();
  const origin = useLocationPart("origin");
  const protocol = useLocationPart("protocol");

  const connection = mcpConnectionMode(
    { state: status.status, auth: status.data?.mcp?.auth },
    protocol,
  );
  const endpoint = mcpEndpoint(
    { state: status.status, endpoint: status.data?.mcp?.endpoint },
    origin,
  );

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("title")}
        summary={t("description")}
        help={<p>{t("help")}</p>}
        helpHref={tLinks("mcp")}
        status={
          <StatusBadge tone={settings.mcpEnabled ? "success" : "neutral"}>
            {settings.mcpEnabled ? t("on") : t("off")}
          </StatusBadge>
        }
      >
        <SettingRow
          label={t("switch.label")}
          htmlFor="ai-mcp-enabled"
          help={<p>{t("switch.description")}</p>}
        >
          <Switch
            id="ai-mcp-enabled"
            checked={settings.mcpEnabled}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.save(buildUpdate(settings, { mcpEnabled: checked }))}
          />
        </SettingRow>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-2.5">
          {connection ? (
            <div className="min-w-0 space-y-0.5">
              <p className="flex items-center gap-0.5 text-sm font-medium">
                {connection.mode === "oauth" ? t("mode.oauth.title") : t("mode.personalToken.title")}
                <HelpTip topic={t("mode.help")} href={tLinks("mcp")}>
                  {connection.mode === "oauth" ? (
                    <>
                      <p>{t("mode.oauth.why")}</p>
                      <p>{t("mode.oauth.body")}</p>
                      <p>{t("mode.oauth.internalCa")}</p>
                      <pre className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                        export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem
                      </pre>
                    </>
                  ) : (
                    <>
                      <p>{t("mode.personalToken.why")}</p>
                      <p>{t("mode.personalToken.body")}</p>
                      <p>{t("mode.personalToken.whyNoOauth")}</p>
                    </>
                  )}
                  <p className="flex items-start gap-1.5">
                    <GlobeAltIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
                    <span>
                      {connection.mode === "oauth"
                        ? t("mode.oauth.cloud")
                        : t("mode.personalToken.cloud")}
                    </span>
                  </p>
                </HelpTip>
              </p>
              {connection.source === "browser" ? (
                <p className="text-xs text-muted-foreground">{t("mode.detectedFromBrowser")}</p>
              ) : null}
            </div>
          ) : (
            <div className="w-full space-y-1.5" aria-busy="true" role="status">
              <span className="sr-only">{t("mode.loading")}</span>
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          <span className="inline-flex items-center gap-0.5">
            <Link
              href="/account/ai"
              className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
            >
              {t("install.link")}
              <ArrowTopRightOnSquareIcon className="size-4" aria-hidden />
            </Link>
            <HelpTip topic={t("install.link")}>
              <p>{t("install.description")}</p>
            </HelpTip>
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-2.5">
          <div className="space-y-0.5">
            <SettingLabel help={<p>{t("endpoint.description")}</p>}>{t("endpoint.label")}</SettingLabel>
            {endpoint?.source === "page" ? (
              <p className="text-xs text-muted-foreground">{t("endpoint.pageFallback")}</p>
            ) : null}
          </div>
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <code className="min-w-0 rounded-md border px-2.5 py-1.5 font-mono text-sm break-all">
              {endpoint?.url ?? "…"}
            </code>
            {endpoint ? <CopyButton value={endpoint.url} label={t("endpoint.copy")} /> : null}
          </div>
        </div>

        <AiErrorNotice error={save.error} />

        {/* The shared install panel (W3-9), for the admin too — only while MCP is usable by this caller. */}
        {status.data?.mcp?.available ? <McpInstallPanel auth={status.data.mcp.auth} /> : null}
      </SettingsSection>

      <AiMcpAllowlistEditor settings={settings} />
    </div>
  );
}
