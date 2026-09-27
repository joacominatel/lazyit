"use client";

import {
  ExclamationTriangleIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  KeyIcon,
  LockClosedIcon,
  PauseCircleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Callout } from "@/components/callout";
import type { McpConnectMode } from "../_lib/mcp-snippets";

const code = (chunks: ReactNode) => (
  <code className="rounded bg-muted px-1 font-mono text-xs">{chunks}</code>
);

/**
 * Says, in every case, how AI apps connect to THIS instance and why (CEO: "La UI debería detectarlo y
 * aclararlo en cualquier caso"): OAuth sign-in on an HTTPS instance, personal tokens on plain HTTP (and
 * why OAuth is not available there), what cloud connectors need, and what a switched-off MCP server
 * means for existing connections. Derived from `GET /ai/status` `mcp` and the page's own protocol.
 */
export function ConnectionModeNotice({ mode }: { mode: McpConnectMode }) {
  const t = useTranslations("oauth.mode");

  if (mode.kind === "unknown") return null;

  if (mode.kind === "unavailable") {
    return (
      <Callout tone="info" icon={<PauseCircleIcon />} className="text-sm">
        <p className="font-medium">{t("unavailable.title")}</p>
        <p className="mt-1 text-muted-foreground">{t("unavailable.body")}</p>
      </Callout>
    );
  }

  const cloud = (
    <p className="mt-2 flex gap-2 text-muted-foreground">
      <GlobeAltIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {mode.kind === "oauth"
          ? t("oauth.cloudConnectors")
          : t("personalToken.cloudConnectors")}
      </span>
    </p>
  );

  if (mode.kind === "oauth") {
    return (
      <div className="space-y-3">
        <Callout tone="info" icon={<LockClosedIcon />} className="text-sm">
          <p className="font-medium">{t("oauth.title")}</p>
          <p className="mt-1 text-muted-foreground">{t("oauth.body")}</p>
          {cloud}
          <p className="mt-2 flex gap-2 text-muted-foreground">
            <InformationCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t.rich("oauth.internalCa", { code })}</span>
          </p>
        </Callout>
        {mode.notes.includes("viewing-over-http") ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />} className="text-sm">
            {t("oauth.viewingOverHttp")}
          </Callout>
        ) : null}
      </div>
    );
  }

  return (
    <Callout tone="info" icon={<KeyIcon />} className="text-sm">
      <p className="font-medium">{t("personalToken.title")}</p>
      <p className="mt-1 text-muted-foreground">
        {mode.notes.includes("https-not-configured")
          ? t.rich("personalToken.httpsNotConfigured", { code })
          : t("personalToken.plainHttp")}
      </p>
      {cloud}
      <p className="mt-2 flex gap-2 text-muted-foreground">
        <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t("personalToken.handleWithCare")}</span>
      </p>
    </Callout>
  );
}
