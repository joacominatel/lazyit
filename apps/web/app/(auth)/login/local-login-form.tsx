"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * Local (first-party) sign-in form — rendered by `/login` only when `authMode === "local"` (ADR-0086 §6).
 * OIDC instances never mount this (they keep the SSO button), so the OIDC path is untouched.
 *
 * Submits via `signIn("credentials", …)` with `redirect: false` so a failure keeps the typed values and
 * shows ONE generic "invalid credentials" message inline (the backend returns a uniform 401 — no
 * enumeration, so the UI must not distinguish "unknown user" from "wrong password"). On success we push
 * to the same-origin `destination` the server already sanitized (open-redirect guard, #495).
 */
export function LocalLoginForm({ destination }: { destination: string }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(false);
    setPending(true);
    try {
      const result = await signIn("credentials", {
        identifier,
        password,
        redirect: false,
      });
      if (!result || result.error) {
        setError(true);
        setPending(false);
        return;
      }
      // Success: navigate to the sanitized destination and refresh so the session-aware shell re-renders.
      router.push(destination);
      router.refresh();
    } catch {
      setError(true);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("login.localHelper")}</p>

        {error && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm"
          >
            <ExclamationTriangleIcon
              className="size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <p className="text-foreground">{t("login.invalidCredentials")}</p>
          </div>
        )}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="identifier">
              {t("login.identifierLabel")}
            </FieldLabel>
            <Input
              id="identifier"
              name="identifier"
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={t("login.identifierPlaceholder")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">{t("login.passwordLabel")}</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("login.passwordPlaceholder")}
            />
          </Field>
        </FieldGroup>

        {/* Self-service recovery (ADR-0086 §F4b) — local mode only; this form only mounts in local mode. */}
        <div className="text-right">
          <Link
            href="/forgot-password"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("login.forgotPassword")}
          </Link>
        </div>
      </CardContent>
      <CardFooter>
        <Button type="submit" className="w-full" disabled={pending}>
          {t("login.localSignInButton")}
        </Button>
      </CardFooter>
    </form>
  );
}
