"use client";

import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import type {
  OAuthAuthorizeParams,
  OAuthAuthorizeValidation,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { Callout } from "@/components/callout";
import { SessionTokenSync } from "@/components/session-token-sync";
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
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/status-badge";
import { useOAuthConsentDecision } from "@/lib/api/hooks/use-oauth-grants";
import { loginCallbackPath } from "@/lib/auth/login-callback";
import { signOutAndRevoke } from "@/lib/auth/sign-out";
import {
  type AccessLevel,
  classifyDecisionError,
  classifyDecisionSuccess,
  consentChoices,
  type DecisionOutcome,
  redirectTrustLabel,
  scopesToGrant,
} from "../_lib/consent";
import { ConsentMessage, type ConsentStop } from "./consent-message";

type Consent = Extract<OAuthAuthorizeValidation, { ok: true }>;

/**
 * The consent screen (docs/ai-assistant/frontend.md §5.3; mcp-and-oauth.md §5.2, §12 follow-up 5; G3).
 *
 * - Identity: the client's name — marked "not verified" unless the API verified it — and, as the trust
 *   signal, the HOST the browser returns to, with the full redirect URI. `client_uri` is self-declared:
 *   shown as plain text, never as a link that vouches for the client.
 * - Choice: Read only / Read & write (the requested ones only); `lazyit.admin` is an explicit extra,
 *   never preselected, and asks for the password (step-up).
 * - An unverified client needs a second, explicit confirmation before approval. Nothing here ever
 *   redirects without a click, and a redirect is followed only when it points back at the registered
 *   redirect URI.
 * - Consent is shown on every authorization; nothing is remembered.
 * - CSRF: the decision is a Bearer-authenticated fetch, which a cross-site form cannot forge; framing
 *   is denied app-wide (next.config.ts, Caddy).
 */
export function ConsentForm({
  consent,
  params,
}: {
  consent: Consent;
  params: OAuthAuthorizeParams;
}) {
  const t = useTranslations("oauth.consent");
  const ts = useTranslations("oauth.scopes");
  const choices = consentChoices(consent.scopes);
  const decision = useOAuthConsentDecision();
  const passwordId = useId();

  const [level, setLevel] = useState<AccessLevel | null>(choices.defaultLevel);
  const [admin, setAdmin] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stop, setStop] = useState<ConsentStop | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);

  const granted = scopesToGrant(consent.scopes, level, admin);
  const busy = decision.isPending || done !== null;
  const { client, redirectHost, redirectUri } = consent;
  // The trust signal: the host, or `scheme:// (host)` for a custom-scheme redirect.
  const destination = redirectTrustLabel(redirectUri, redirectHost);

  function handleOutcome(
    outcome: DecisionOutcome,
    kind: "approve" | "deny",
  ): void {
    switch (outcome.kind) {
      case "redirect":
        setPassword("");
        setDone(kind === "approve" ? "approved" : "denied");
        window.location.assign(outcome.redirectTo);
        return;
      case "refusal":
        setStop({ kind: "refusal", refusal: outcome.refusal });
        return;
      case "unsafe-redirect":
        setStop({ kind: "unsafe-redirect" });
        return;
      case "step-up-required":
        setProblem(t("errors.stepUpRequired"));
        return;
      case "step-up-failed":
        setProblem(t("errors.stepUpFailed"));
        setPassword("");
        return;
      case "step-up-unavailable":
        setAdmin(false);
        setPassword("");
        setProblem(t("errors.stepUpUnavailable"));
        return;
      case "rate-limited":
        setProblem(t("errors.rateLimited"));
        return;
      default:
        setStop({ kind: "unknown", requestId: outcome.requestId });
    }
  }

  function send(kind: "approve" | "deny") {
    setProblem(null);
    decision.mutate(
      {
        params,
        decision: kind,
        scopes: kind === "approve" ? granted : [],
        ...(kind === "approve" && admin && password ? { password } : {}),
      },
      {
        // Each answer is read once, then the mutation is reset (with `gcTime: 0`), so neither the
        // password nor the code in the redirect stays in the mutation cache.
        onSuccess: (response) => {
          decision.reset();
          handleOutcome(classifyDecisionSuccess(response, redirectUri), kind);
        },
        onError: (error) => {
          decision.reset();
          handleOutcome(classifyDecisionError(error, redirectUri), kind);
        },
      },
    );
  }

  function onApprove(event: FormEvent) {
    event.preventDefault();
    if (granted.length === 0) {
      setProblem(t("errors.nothingSelected"));
      return;
    }
    if (admin && !password) {
      setProblem(t("errors.stepUpRequired"));
      return;
    }
    // An unverified client always gets a second, explicit confirmation (G3).
    if (!client.verified) {
      setConfirmOpen(true);
      return;
    }
    send("approve");
  }

  if (stop) return <ConsentMessage stop={stop} />;

  if (done) {
    return (
      <Card className="w-full animate-rise-in shadow-e2">
        <CardHeader>
          <div className="flex items-start gap-3">
            <CheckCircleIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
            <div className="space-y-1.5">
              <CardTitle className="font-display">
                {done === "approved" ? t("done.approvedTitle") : t("done.deniedTitle")}
              </CardTitle>
              <CardDescription>
                {t("done.body", { name: client.name, host: destination })}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full animate-rise-in shadow-e2">
      <SessionTokenSync />
      <form onSubmit={onApprove} noValidate>
        <CardHeader className="space-y-3">
          <CardTitle className="font-display text-xl break-words">
            {t("title", { name: client.name })}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {client.verified ? (
              <StatusBadge tone="success">
                <ShieldCheckIcon aria-hidden />
                {t("verified")}
              </StatusBadge>
            ) : (
              <StatusBadge tone="warning">{t("unverified")}</StatusBadge>
            )}
            <span className="text-muted-foreground">
              {client.verified ? t("verifiedHint") : t("unverifiedHint")}
            </span>
          </div>
          <CardDescription>
            {t("actsAsYou", { email: consent.user.email })}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5 text-sm">
          {/* The trust signal: where the browser goes after the decision. */}
          <section aria-labelledby="consent-redirect" className="space-y-1 rounded-md border p-3">
            <h2 id="consent-redirect" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("redirect.heading")}
            </h2>
            <p className="font-mono text-base font-semibold break-all">{destination}</p>
            <p className="font-mono text-xs break-all text-muted-foreground">{redirectUri}</p>
            {consent.loopbackOnly ? (
              <p className="text-xs text-muted-foreground">{t("redirect.loopback")}</p>
            ) : null}
            {client.uri ? (
              <p className="text-xs text-muted-foreground">
                {t("redirect.statedWebsite")}{" "}
                <span className="font-mono break-all">{client.uri}</span>
              </p>
            ) : null}
          </section>

          {!client.verified ? (
            <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
              {t("unverifiedWarning", { host: destination })}
            </Callout>
          ) : null}

          {choices.levels.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="mb-1 font-medium">{t("access.legend")}</legend>
              {choices.levels.map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[:checked]:border-primary"
                >
                  <input
                    type="radio"
                    name="access"
                    value={value}
                    checked={level === value}
                    onChange={() => setLevel(value)}
                    disabled={busy}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    <span className="font-medium">{t(`access.${value}.label`)}</span>
                    <span className="block text-muted-foreground">
                      {t(`access.${value}.description`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {choices.adminOffered ? (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[:checked]:border-warning">
                <input
                  type="checkbox"
                  checked={admin}
                  onChange={(e) => {
                    setAdmin(e.target.checked);
                    if (!e.target.checked) setPassword("");
                  }}
                  disabled={busy}
                  className="mt-0.5 size-4 rounded border-input accent-primary"
                />
                <span>
                  <span className="font-medium">{ts("admin.label")}</span>
                  <span className="block text-muted-foreground">{ts("admin.description")}</span>
                </span>
              </label>
              {admin ? (
                <div className="space-y-1.5 pl-1">
                  <Label htmlFor={passwordId}>{t("password.label")}</Label>
                  <Input
                    id={passwordId}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                  <p className="text-xs text-muted-foreground">{t("password.hint")}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="text-muted-foreground">{t("revokeHint")}</p>

          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <div className="flex w-full flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => send("deny")}
              disabled={busy}
            >
              {t("deny")}
            </Button>
            <Button type="submit" disabled={busy || granted.length === 0}>
              {t("allow")}
            </Button>
          </div>
          <p className="w-full text-right text-xs text-muted-foreground">
            {t("notYou")}{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              // Sign in as the right person and come straight back to this request.
              onClick={() => void signOutAndRevoke(loginCallbackPath(window.location))}
              disabled={busy}
            >
              {t("signOut")}
            </button>
          </p>
        </CardFooter>
      </form>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmUnverified.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmUnverified.body", {
                name: client.name,
                host: destination,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirmUnverified.cancel")}</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                send("approve");
              }}
            >
              {t("confirmUnverified.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
