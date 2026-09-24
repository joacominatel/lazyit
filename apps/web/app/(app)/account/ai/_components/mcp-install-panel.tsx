"use client";

import {
  ArrowDownTrayIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { AiMcpAuthMode } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api/client";
import { downloadClaudeCodePlugin } from "@/lib/api/endpoints/oauth";
import { useOAuthIssuer } from "@/lib/api/hooks/use-oauth-grants";
import { notifyError } from "@/lib/api/notify-error";
import {
  buildMcpClientSnippets,
  claudePluginCommands,
  marketplaceName,
  parseServerOrigin,
  resolveSnippetOrigin,
  type SnippetOrigin,
  TOKEN_PLACEHOLDER,
} from "../_lib/mcp-snippets";
import { usePageLocation } from "../_lib/use-page-location";
import { CodeSnippet } from "./code-snippet";

const PLUGIN_FILE_NAME = "lazyit-plugin.zip";

const code = (chunks: ReactNode) => (
  <code className="rounded bg-muted px-1 font-mono text-xs">{chunks}</code>
);

/**
 * "Install in Claude Code" and "Other MCP clients" (docs/ai-assistant/frontend.md §5.3, mcp-and-oauth.md
 * §13). Rendered on `/account/ai` and — for admins — embedded by Settings → AI (W3-8). The caller shows
 * it only when `GET /ai/status` says `mcp.available`, and passes the instance's `mcp.auth`:
 *
 * - `oauth` (HTTPS): the one-step marketplace install, then `/mcp` to sign in; auto-update is off by
 *   default for third-party marketplaces, and the panel says how to turn it on.
 * - `personal-token` (plain-HTTP `lan`): the plugin download only (a marketplace needs HTTPS); Claude Code
 *   asks for the personal token when the plugin is enabled.
 *
 * Every snippet derives from the page's own origin and never carries a real token.
 */
export function McpInstallPanel({ auth }: { auth: AiMcpAuthMode }) {
  const t = useTranslations("oauth.install");
  const location = usePageLocation();
  // OAuth clients must use the address the server knows for itself (the issuer tokens are bound to),
  // not whatever address this page was opened at.
  const issuer = useOAuthIssuer({ enabled: auth === "oauth" });

  if (!location || (auth === "oauth" && issuer.isPending)) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const resolved: SnippetOrigin =
    auth === "oauth"
      ? resolveSnippetOrigin(location.origin, parseServerOrigin(issuer.data))
      : // Personal tokens (plain HTTP, host-agnostic): the address the reader reached is the one to use.
        { origin: location.origin, check: "match" };
  const { origin } = resolved;
  const copyable = resolved.check === "match";
  const snippets = buildMcpClientSnippets(origin, auth);
  const plugin = claudePluginCommands(origin);
  const marketplace = marketplaceName(origin);

  return (
    <div className="space-y-6">
      {resolved.check === "mismatch" ? (
        <Callout tone="warning" icon={<ExclamationTriangleIcon />} className="text-sm">
          {t.rich("originMismatch", {
            code,
            page: resolved.pageOrigin,
            server: resolved.origin,
          })}
        </Callout>
      ) : resolved.check === "unverified" ? (
        <Callout tone="warning" icon={<ExclamationTriangleIcon />} className="text-sm">
          {t.rich("originUnverified", { code, page: resolved.origin })}
        </Callout>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("claudeCode.title")}</CardTitle>
          <CardDescription>{t("claudeCode.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 text-sm">
          {auth === "oauth" ? (
            <ol className="list-decimal space-y-4 pl-5">
              <li className="space-y-2">
                <p>{t("claudeCode.oauth.stepInstall")}</p>
                <CodeSnippet
                  copyable={copyable}
                  code={`${plugin.marketplaceAdd}\n${plugin.pluginInstall}`}
                  label={t("claudeCode.oauth.copyInstall")}
                />
              </li>
              <li>
                <p>{t.rich("claudeCode.oauth.stepSignIn", { code })}</p>
              </li>
              <li>
                <p>
                  {t.rich("claudeCode.oauth.stepUpdates", {
                    code,
                    marketplace,
                  })}
                </p>
              </li>
            </ol>
          ) : (
            <p className="text-muted-foreground">
              {t("claudeCode.personalToken.noMarketplace")}
            </p>
          )}

          <div className="space-y-2 border-t pt-4">
            <p className="font-medium">
              {auth === "oauth"
                ? t("claudeCode.manual.titleAlternative")
                : t("claudeCode.manual.title")}
            </p>
            <ol className="list-decimal space-y-3 pl-5">
              <li className="space-y-2">
                <p>{t("claudeCode.manual.stepDownload")}</p>
                <PluginDownloadButton />
              </li>
              <li className="space-y-2">
                <p>{t("claudeCode.manual.stepUnzip")}</p>
                <CodeSnippet
                  copyable={copyable}
                  code={`mkdir -p ~/.claude/skills/lazyit\nunzip -o ${PLUGIN_FILE_NAME} -d ~/.claude/skills/lazyit`}
                  label={t("claudeCode.manual.copyUnzip")}
                />
                <p className="text-muted-foreground">
                  {t.rich("claudeCode.manual.tryOnce", {
                    code,
                    command: `claude --plugin-dir ./${PLUGIN_FILE_NAME}`,
                  })}
                </p>
              </li>
              <li>
                <p>
                  {auth === "oauth"
                    ? t.rich("claudeCode.manual.stepSignInOauth", { code })
                    : t("claudeCode.manual.stepToken")}
                </p>
              </li>
            </ol>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("clients.title")}</CardTitle>
          <CardDescription>
            {auth === "oauth"
              ? t("clients.descriptionOauth")
              : t.rich("clients.descriptionToken", {
                  code,
                  placeholder: TOKEN_PLACEHOLDER,
                })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium">{t("clients.endpoint")}</p>
            <CodeSnippet
                  copyable={copyable}
              code={snippets.endpoint}
              label={t("clients.copyEndpoint")}
            />
          </div>
          <Tabs defaultValue="claude-code">
            <TabsList>
              <TabsTrigger value="claude-code">
                {t("clients.tabs.claudeCode")}
              </TabsTrigger>
              <TabsTrigger value="cursor">{t("clients.tabs.cursor")}</TabsTrigger>
              <TabsTrigger value="vscode">{t("clients.tabs.vscode")}</TabsTrigger>
              <TabsTrigger value="other">{t("clients.tabs.other")}</TabsTrigger>
            </TabsList>
            <TabsContent value="claude-code" className="space-y-2 pt-2">
              <p className="text-muted-foreground">
                {t("clients.claudeCode.hint")}
              </p>
              <CodeSnippet
                  copyable={copyable}
                code={snippets.claudeCode}
                label={t("clients.claudeCode.copy")}
              />
            </TabsContent>
            <TabsContent value="cursor" className="space-y-2 pt-2">
              <p className="text-muted-foreground">
                {t.rich("clients.cursor.hint", { code })}
              </p>
              <CodeSnippet copyable={copyable} code={snippets.cursor} label={t("clients.cursor.copy")} />
            </TabsContent>
            <TabsContent value="vscode" className="space-y-2 pt-2">
              <p className="text-muted-foreground">
                {auth === "oauth"
                  ? t.rich("clients.vscode.hintOauth", { code })
                  : t.rich("clients.vscode.hintToken", { code })}
              </p>
              <CodeSnippet copyable={copyable} code={snippets.vscode} label={t("clients.vscode.copy")} />
            </TabsContent>
            <TabsContent value="other" className="space-y-2 pt-2">
              <p className="text-muted-foreground">
                {auth === "oauth"
                  ? t("clients.other.hintOauth")
                  : t("clients.other.hintToken")}
              </p>
              {snippets.authorizationHeader ? (
                <CodeSnippet
                  copyable={copyable}
                  code={snippets.authorizationHeader}
                  label={t("clients.other.copyHeader")}
                />
              ) : null}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Download the plugin (`GET /api/ai/claude-code/plugin.zip`, Bearer) and hand it to the browser as a
 * file. 404 = MCP was switched off meanwhile; 409 `ORIGIN_UNKNOWN` = the instance does not know its own
 * address (an administrator sets it).
 */
function PluginDownloadButton() {
  const t = useTranslations("oauth.install.claudeCode.manual");
  const [pending, setPending] = useState(false);

  async function onDownload() {
    setPending(true);
    try {
      const blob = await downloadClaudeCodePlugin();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = PLUGIN_FILE_NAME;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Deferred: revoking synchronously can cancel the download before the browser has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      const code =
        error instanceof ApiError
          ? (error.body as { code?: unknown } | undefined)?.code
          : undefined;
      if (code === "ORIGIN_UNKNOWN") {
        toast.error(t("errors.originUnknown"));
      } else if (error instanceof ApiError && error.status === 404) {
        toast.error(t("errors.unavailable"));
      } else {
        notifyError(error, t("errors.generic"));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onDownload}
      disabled={pending}
    >
      <ArrowDownTrayIcon aria-hidden />
      {t("download")}
    </Button>
  );
}
