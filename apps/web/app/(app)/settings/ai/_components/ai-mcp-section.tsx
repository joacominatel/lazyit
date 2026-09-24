"use client";

import {
  ArrowTopRightOnSquareIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  LinkIcon,
} from "@heroicons/react/24/outline";
import type { AiSettings } from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { Callout } from "@/components/callout";
import { CopyButton } from "@/components/copy-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config";
import { useAiStatus } from "@/lib/api/hooks/use-ai-status";
import {
  buildUpdate,
  mcpConnectionMode,
  mcpEndpointUrl,
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
 * Settings → AI: external AI agents over MCP (ADR-0097; frontend.md §5.3; mcp-and-oauth.md §8, §14).
 * The MCP switch is independent of the LLM provider — MCP works with no provider configured. The card
 * reads how clients authenticate on THIS instance from `/ai/status` (`mcp.auth`) and says it in plain
 * words: OAuth sign-in on an HTTPS instance; personal tokens on a plain-HTTP `lan` instance, where OAuth
 * cannot work. It also names the two traps operators hit: an internal CA that Claude Code (Node.js) does
 * not trust, and cloud connectors (claude.ai, ChatGPT) that need a publicly reachable HTTPS instance.
 * The install panel itself lives on the per-user page `/account/ai`.
 */
export function AiMcpSection({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.mcp");
  const save = useAiConfigSave();
  const status = useAiStatus();
  const origin = useLocationPart("origin");
  const protocol = useLocationPart("protocol");

  const connection = mcpConnectionMode(
    { state: status.status, auth: status.data?.mcp?.auth },
    protocol,
  );
  const endpoint = origin ? mcpEndpointUrl(origin) : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <LinkIcon className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>{t("title")}</CardTitle>
          </div>
          <StatusBadge tone={settings.mcpEnabled ? "success" : "neutral"}>
            {settings.mcpEnabled ? t("on") : t("off")}
          </StatusBadge>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field orientation="horizontal" className="rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-1 flex-col gap-0.5">
            <FieldLabel htmlFor="ai-mcp-enabled" className="font-medium">
              {t("switch.label")}
            </FieldLabel>
            <FieldDescription>{t("switch.description")}</FieldDescription>
          </div>
          <Switch
            id="ai-mcp-enabled"
            checked={settings.mcpEnabled}
            disabled={save.isPending}
            onCheckedChange={(checked) =>
              save.save(buildUpdate(settings, { mcpEnabled: checked }))
            }
          />
        </Field>
        <AiErrorNotice error={save.error} />

        {connection ? (
          <Callout tone="info" icon={<InformationCircleIcon />}>
            <div className="space-y-2 text-sm">
              <p className="font-medium">
                {connection.mode === "oauth" ? t("mode.oauth.title") : t("mode.personalToken.title")}
              </p>
              {connection.mode === "oauth" ? (
                <>
                  <p>{t("mode.oauth.body")}</p>
                  <p>{t("mode.oauth.internalCa")}</p>
                  <pre className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                    export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem
                  </pre>
                </>
              ) : (
                <>
                  <p>{t("mode.personalToken.body")}</p>
                  <p>{t("mode.personalToken.whyNoOauth")}</p>
                </>
              )}
              <p className="flex items-start gap-1.5">
                <GlobeAltIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
                <span>
                  {connection.mode === "oauth" ? t("mode.oauth.cloud") : t("mode.personalToken.cloud")}
                </span>
              </p>
              {connection.source === "browser" ? (
                <p className="text-muted-foreground">{t("mode.detectedFromBrowser")}</p>
              ) : null}
            </div>
          </Callout>
        ) : (
          <div
            className="space-y-2 rounded-md border p-3"
            aria-busy="true"
            role="status"
          >
            <span className="sr-only">{t("mode.loading")}</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">{t("endpoint.label")}</p>
          <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <code className="min-w-0 flex-1 font-mono text-sm break-all">{endpoint ?? "…"}</code>
            {endpoint ? <CopyButton value={endpoint} label={t("endpoint.copy")} /> : null}
          </div>
          <p className="text-sm text-muted-foreground">{t("endpoint.description")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            href="/account/ai"
            className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            {t("install.link")}
            <ArrowTopRightOnSquareIcon className="size-4" aria-hidden />
          </Link>
          <span className="text-muted-foreground">{t("install.description")}</span>
        </div>

        <Separator />

        <AiMcpAllowlistEditor settings={settings} />
      </CardContent>
    </Card>
  );
}
