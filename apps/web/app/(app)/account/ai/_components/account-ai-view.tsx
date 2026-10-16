"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiStatus } from "@/lib/api/hooks/use-ai-status";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { detectMcpConnectMode } from "../_lib/mcp-snippets";
import { usePageLocation } from "../_lib/use-page-location";
import { ConnectedAppsSection } from "./connected-apps-section";
import { ConnectionModeNotice } from "./connection-mode-notice";
import { McpInstallPanel } from "./mcp-install-panel";

/**
 * `/account/ai` — "AI & connected apps" (ADR-0097; docs/ai-assistant/frontend.md Fork F, §5.3). Per user,
 * for everyone (AUD-083: a user without `ai:connect` still lists and revokes what they hold):
 *
 * 1. how AI apps connect to this instance and why (OAuth on HTTPS, personal tokens on plain HTTP, MCP
 *    off) — always explained, from `GET /ai/status` `mcp` and the page's own protocol;
 * 2. the install panel (Claude Code plugin + other MCP clients), only while `mcp.available`;
 * 3. the caller's connected apps and personal tokens, with revoke — always, so a paused connection can
 *    still be cut.
 *
 * The UI gates only what it draws; the API is the real gate.
 */
export function AccountAiView() {
  const t = useTranslations("oauth.account");
  const { can, isLoading } = useMyPermissions();
  const status = useAiStatus();
  const location = usePageLocation();

  const header = (
    <PageHeader title={t("title")} subtitle={t("subtitle")} />
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {header}
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const mode = location
    ? detectMcpConnectMode(status, location.protocol)
    : ({ kind: "unknown" } as const);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {header}
      {status.isPending || !location ? (
        <Skeleton className="h-24 w-full" />
      ) : status.isError ? (
        <p className="text-sm text-muted-foreground">{t("statusError")}</p>
      ) : (
        <ConnectionModeNotice mode={mode} canConnect={can("ai:connect")} />
      )}
      {mode.kind === "oauth" || mode.kind === "personal-token" ? (
        <McpInstallPanel auth={mode.kind} />
      ) : null}
      <ConnectedAppsSection canCreateTokens={mode.kind === "personal-token"} />
    </div>
  );
}
