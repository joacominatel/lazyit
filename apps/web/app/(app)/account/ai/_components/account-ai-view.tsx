"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
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
 * for holders of `ai:connect`:
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
  const allowed = can("ai:connect");

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

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {header}
        <div
          role="status"
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center"
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-muted">
            <LockClosedIcon className="size-6 text-muted-foreground" aria-hidden />
          </span>
          <p className="font-medium">{t("forbidden.title")}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("forbidden.body")}
          </p>
        </div>
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
        <ConnectionModeNotice mode={mode} />
      )}
      {mode.kind === "oauth" || mode.kind === "personal-token" ? (
        <McpInstallPanel auth={mode.kind} />
      ) : null}
      <ConnectedAppsSection canCreateTokens={mode.kind === "personal-token"} />
    </div>
  );
}
