import {
  ExclamationTriangleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getConfigStatus } from "@/lib/api/endpoints/config";
import { safeInternalPath } from "@/lib/utils/safe-redirect";

/**
 * Sign-in page — redirects the user to the configured OIDC provider.
 *
 * Auth.js v5 handles the full OIDC flow (authorization code + PKCE):
 *   1. User clicks "Sign in"
 *   2. Auth.js redirects to the IdP (Zitadel by default — ADR-0037)
 *   3. IdP authenticates and redirects back to /api/auth/callback/oidc
 *   4. Auth.js stores the session cookie (JWT, ADR-0039) and redirects to the app
 *
 * The (auth) layout provides the shared AuthShell (centered card + wordmark + theme toggle).
 *
 * Redirect handling: `proxy.ts` sends unauthenticated visitors here with a `callbackUrl` query param
 * (their intended destination). We forward that to `signIn` via `redirectTo` so a successful login
 * lands in the app, and we bounce already-authenticated visitors straight there (default
 * `/dashboard`).
 *
 * Recourse (ADR-0043 §7): when the IdP bounces a user back unauthenticated, Auth.js redirects here
 * with `?error=<code>`. We translate that into a clear, IT-native explanation instead of a silent
 * dead-end. And when the instance is UNCONFIGURED (no ADMIN yet — the SSO has no one to sign in), we
 * surface a prominent "Set up lazyit" link to /setup so a fresh operator is never stranded.
 *
 * BYOI: the IdP label ("Your organization") comes from the provider `name` in auth.ts. Operators with
 * a branded IdP can change it there — no UI code to touch.
 */

/**
 * Maps each Auth.js sign-in error code (the codes Auth.js passes back to a custom sign-in page) to its
 * translation-key base under the `auth.errors` namespace. The codes themselves are data sent by
 * Auth.js — only the key base and the resolved copy are localized. Anything unrecognized falls through
 * to the `default` message.
 */
const ERROR_KEY_BASE: Record<string, string> = {
  Configuration: "configuration",
  AccessDenied: "accessDenied",
  Verification: "verification",
  Default: "default",
};

/** Resolve whether this instance still needs first-run setup; fail safe (no link) if the API is down. */
async function instanceIsUnconfigured(): Promise<boolean> {
  try {
    const status = await getConfigStatus();
    return status.isConfigured === false;
  } catch {
    return false;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const { callbackUrl, error } = await searchParams;
  // Open-redirect guard (#495): `callbackUrl` is attacker-controllable, so collapse it to a
  // guaranteed same-origin path. Applied to BOTH the authenticated `redirect()` below (the unsafe
  // branch) and — defensively — the `redirectTo` handed to `signIn`.
  const destination = safeInternalPath(callbackUrl);

  // Already signed in → skip the login screen.
  if (await auth()) {
    redirect(destination);
  }

  const [t, unconfigured] = await Promise.all([getTranslations("auth"), instanceIsUnconfigured()]);
  const errorKeyBase = error
    ? (ERROR_KEY_BASE[error] ?? ERROR_KEY_BASE.Default)
    : null;

  return (
    <Card className="w-full animate-rise-in shadow-e2">
      <CardHeader>
        <CardTitle className="font-display">{t("login.title")}</CardTitle>
        <CardDescription>{t("login.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorKeyBase && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm"
          >
            <ExclamationTriangleIcon
              className="size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">
                {t(`errors.${errorKeyBase}Title`)}
              </p>
              <p className="text-muted-foreground">
                {t(`errors.${errorKeyBase}Detail`)}
              </p>
            </div>
          </div>
        )}

        {unconfigured ? (
          <div className="flex gap-3 rounded-lg border border-info/30 bg-info/8 p-3 text-sm">
            <WrenchScrewdriverIcon
              className="size-5 shrink-0 text-info"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">
                {t("login.unconfiguredTitle")}
              </p>
              <p className="text-muted-foreground">
                {t("login.unconfiguredDetail")}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("login.ssoHelper")}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex-col gap-2">
        {unconfigured ? (
          <Button asChild className="w-full">
            <Link href="/setup">{t("login.setupButton")}</Link>
          </Button>
        ) : (
          <form
            action={async () => {
              "use server";
              await signIn("oidc", { redirectTo: destination });
            }}
            className="w-full"
          >
            <Button type="submit" className="w-full">
              {t("login.signInButton")}
            </Button>
          </form>
        )}
      </CardFooter>
    </Card>
  );
}
