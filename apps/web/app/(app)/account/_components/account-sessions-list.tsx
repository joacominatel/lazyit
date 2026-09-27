"use client";

import {
  ArrowPathIcon,
  ClockIcon,
  ComputerDesktopIcon,
} from "@heroicons/react/24/outline";
import type { UserSession } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useSecretSession } from "@/app/(app)/secrets/_components/secret-session";
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
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError } from "@/lib/api/client";
import {
  useEndMySession,
  useMySessions,
} from "@/lib/api/hooks/use-my-sessions";
import { notifyError } from "@/lib/api/notify-error";
import { signOutLocally } from "@/lib/auth/sign-out";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { deviceLabel, sessionListEntries } from "../_lib/session-rows";

/**
 * "Your sessions" — the caller's signed-in devices in `AUTH_MODE=local` (#1420, ADR-0086 §9). Rendered by
 * the security panel in local mode only; an OIDC instance never asks (its sessions belong to the IdP).
 *
 * Each row shows browser · OS, IP, when it signed in and when it was last active, with a "This device"
 * badge on the current one and "Keep me signed in" where it applies. "End" asks first:
 *
 * - another device → `DELETE /auth/sessions/:id`; its token dies on its next request.
 * - this device → the same DELETE, then the user menu's sign-out path WITHOUT the revoke-everything call:
 *   lock the in-memory secret session, drop the cookie, land on /login. `POST /auth/logout` would end the
 *   other devices too, which is not what the user asked for.
 *
 * A session opened before the upgrade has no row (`currentIsLegacy`): one synthetic entry stands for this
 * device, with no End action — "Sign out on all devices" is what ends it.
 *
 * The query is client-only (#1448): during hydration it reads pending, as the server rendered, so the
 * relative "last active" times never enter the server HTML.
 */
export function AccountSessionsList() {
  const t = useTranslations("account.hub.security.devices");
  const { data, isPending, isError, error, refetch } = useMySessions(true);
  const [ending, setEnding] = useState<UserSession | null>(null);
  const entries = sessionListEntries(data);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : isError ? (
        <ErrorState
          title={t("error.title")}
          description={t("error.description")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg ring-1 ring-foreground/10">
          {entries.map((entry) =>
            entry.kind === "legacy" ? (
              <LegacyRow key="legacy" />
            ) : (
              <SessionRow
                key={entry.session.id}
                session={entry.session}
                onEnd={() => setEnding(entry.session)}
              />
            ),
          )}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("containment")}</p>
      <EndSessionDialog
        session={ending}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
      />
    </div>
  );
}

function SessionRow({
  session,
  onEnd,
}: {
  session: UserSession;
  onEnd: () => void;
}) {
  const t = useTranslations("account.hub.security.devices");
  const { date, dateTime, relative } = useFormatters();
  const device = deviceLabel(session) ?? t("unknownDevice");

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <ComputerDesktopIcon
            className="size-4 text-muted-foreground"
            aria-hidden
          />
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span
              className="font-medium break-words"
              title={session.userAgent ?? undefined}
            >
              {device}
            </span>
            {session.current ? (
              <StatusBadge tone="info">{t("thisDevice")}</StatusBadge>
            ) : null}
            {session.rememberMe ? (
              <StatusBadge tone="neutral">{t("keepSignedIn")}</StatusBadge>
            ) : null}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>{t("ip")}</dt>
            <dd className="font-mono break-all">
              {session.ip ?? t("unknownIp")}
            </dd>
            <dt>{t("signedIn")}</dt>
            <dd className="tabular-nums" title={dateTime(session.createdAt)}>
              {date(session.createdAt)}
            </dd>
            <dt>{t("lastActive")}</dt>
            <dd className="tabular-nums" title={dateTime(session.lastSeenAt)}>
              {relative(session.lastSeenAt)}
            </dd>
          </dl>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={onEnd}
        aria-label={t("endAria", { device })}
      >
        {t("end")}
      </Button>
    </li>
  );
}

function LegacyRow() {
  const t = useTranslations("account.hub.security.devices");
  return (
    <li className="flex gap-3 p-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <ClockIcon className="size-4 text-muted-foreground" aria-hidden />
      </span>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t("legacyTitle")}</span>
          <StatusBadge tone="info">{t("thisDevice")}</StatusBadge>
        </p>
        <p className="text-xs text-muted-foreground">{t("legacyNote")}</p>
      </div>
    </li>
  );
}

function EndSessionDialog({
  session,
  onOpenChange,
}: {
  session: UserSession | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("account.hub.security.devices");
  const end = useEndMySession();
  const { lock } = useSecretSession();
  // Keeps the spinner up from the DELETE through the navigation to /login when ending this device.
  const [signingOut, setSigningOut] = useState(false);
  const busy = end.isPending || signingOut;
  const current = session?.current === true;
  const device = session
    ? (deviceLabel(session) ?? t("unknownDevice"))
    : "";

  async function handleEnd() {
    if (!session) return;
    try {
      await end.mutateAsync({ id: session.id, current: session.current });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Already ended elsewhere (or swept): the list was stale. Say so and refresh it.
        toast.info(t("alreadyEnded"));
        onOpenChange(false);
        return;
      }
      notifyError(error, t("endError"));
      return;
    }
    if (session.current) {
      // This device's token is dead now: sign out here the way the user menu does — lock the secret
      // session first (#512) — but without `POST /auth/logout`, which would end every other device.
      setSigningOut(true);
      lock();
      await signOutLocally();
      return;
    }
    toast.success(t("ended"));
    onOpenChange(false);
  }

  return (
    <AlertDialog open={session !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {current ? t("confirm.currentTitle") : t("confirm.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {current
              ? t("confirm.currentDescription")
              : t("confirm.description", { device })}
          </AlertDialogDescription>
          <p className="text-sm text-muted-foreground">{t("containment")}</p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("confirm.cancel")}
          </AlertDialogCancel>
          <Button variant="destructive" onClick={handleEnd} disabled={busy}>
            {busy && <ArrowPathIcon className="animate-spin" />}
            {current ? t("confirm.currentConfirm") : t("confirm.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
