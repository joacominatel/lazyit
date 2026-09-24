"use client";

import {
  CommandLineIcon,
  KeyIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { OAuthGrant, OAuthScope } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/resource-table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  useMyOAuthGrants,
  useRevokeOAuthGrant,
} from "@/lib/api/hooks/use-oauth-grants";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { scopeMessageKey } from "../_lib/scope-labels";
import { PersonalTokenDialog } from "./personal-token-dialog";

/**
 * The live personal-token cap per user, as the API enforces it (409 past it;
 * apps/api/src/oauth/personal-tokens/personal-tokens.service.ts `MAX_LIVE_PERSONAL_TOKENS`). Shown only as
 * guidance — the API is the gate.
 */
const PERSONAL_TOKEN_CAP = 20;

/**
 * "Connected apps" — every live connection of the caller: OAuth apps they approved and personal tokens
 * they created (`GET /oauth/grants/mine`), with revoke (`DELETE /oauth/grants/:id`). Listing and revoking
 * work whatever the instance mode or the MCP switch, so nothing that exists is ever unmanageable.
 * `canCreateTokens` adds "Create token" on a personal-token instance with MCP on.
 */
export function ConnectedAppsSection({
  canCreateTokens,
}: {
  canCreateTokens: boolean;
}) {
  const t = useTranslations("oauth.connectedApps");
  const { data, isPending, isError, error, refetch } = useMyOAuthGrants();
  const [createOpen, setCreateOpen] = useState(false);
  const personalCount = data?.filter((g) => g.kind === "personal").length ?? 0;
  const atCap = personalCount >= PERSONAL_TOKEN_CAP;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        {canCreateTokens ? (
          <Button
            type="button"
            size="sm"
            onClick={() => setCreateOpen(true)}
            disabled={atCap}
            title={atCap ? t("tokenCap", { max: PERSONAL_TOKEN_CAP }) : undefined}
          >
            <PlusIcon aria-hidden />
            {t("createToken")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : isError ? (
          <ErrorState
            title={t("error.title")}
            description={t("error.description")}
            onRetry={() => refetch()}
            error={error}
          />
        ) : data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {canCreateTokens ? t("emptyTokens") : t("empty")}
          </p>
        ) : (
          <ul className="divide-y">
            {data.map((grant) => (
              <GrantRow key={grant.id} grant={grant} />
            ))}
          </ul>
        )}
        {canCreateTokens && personalCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("tokenCount", { count: personalCount, max: PERSONAL_TOKEN_CAP })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("pausedNote")}</p>
      </CardContent>
      {canCreateTokens ? (
        <PersonalTokenDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </Card>
  );
}

function ScopeList({ scopes }: { scopes: readonly OAuthScope[] }) {
  const t = useTranslations("oauth.scopes");
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <StatusBadge
          key={scope}
          tone={scope === "lazyit.admin" ? "warning" : "neutral"}
        >
          {t(`${scopeMessageKey(scope)}.short`)}
        </StatusBadge>
      ))}
    </span>
  );
}

function GrantRow({ grant }: { grant: OAuthGrant }) {
  const t = useTranslations("oauth.connectedApps");
  const { date, dateTime, relative } = useFormatters();
  const revoke = useRevokeOAuthGrant();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isPersonal = grant.kind === "personal";
  const name = isPersonal
    ? (grant.label ?? t("unnamedToken"))
    : (grant.client?.name ?? t("unknownApp"));
  const Icon = isPersonal ? KeyIcon : CommandLineIcon;

  function onRevoke() {
    revoke.mutate(grant.id, {
      onSuccess: () => {
        toast.success(t("revoke.done", { name }));
        setConfirmOpen(false);
      },
      onError: (error) => notifyError(error, t("revoke.error")),
    });
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-all">{name}</span>
            <span className="text-xs text-muted-foreground">
              {isPersonal ? t("kind.personal") : t("kind.oauth")}
            </span>
            {!isPersonal && grant.client && !grant.client.verified ? (
              <StatusBadge tone="warning">{t("unverified")}</StatusBadge>
            ) : null}
          </p>
          {grant.redirectHost ? (
            <p className="text-xs text-muted-foreground">
              {t("redirectHost")}{" "}
              <span className="font-mono">{grant.redirectHost}</span>
            </p>
          ) : null}
          <ScopeList scopes={grant.scopes} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>{t("created")}</dt>
            <dd className="tabular-nums" title={dateTime(grant.createdAt)}>
              {date(grant.createdAt)}
            </dd>
            <dt>{t("lastUsed")}</dt>
            <dd
              className="tabular-nums"
              title={grant.lastUsedAt ? dateTime(grant.lastUsedAt) : undefined}
            >
              {grant.lastUsedAt ? relative(grant.lastUsedAt) : t("never")}
            </dd>
            {grant.expiresAt ? (
              <>
                <dt>{t("expires")}</dt>
                <dd className="tabular-nums" title={dateTime(grant.expiresAt)}>
                  {date(grant.expiresAt)}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        aria-label={t("revoke.aria", { name })}
      >
        {t("revoke.action")}
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revoke.title", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {isPersonal ? t("revoke.bodyToken") : t("revoke.bodyApp")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              {t("revoke.cancel")}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={onRevoke}
              disabled={revoke.isPending}
            >
              {t("revoke.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
