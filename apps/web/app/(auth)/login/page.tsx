import {
  ExclamationTriangleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
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
 * Human-readable copy for the Auth.js sign-in error codes (the codes Auth.js passes back to a custom
 * sign-in page). Anything unrecognized falls through to the `Default` message.
 */
const ERROR_COPY: Record<string, { title: string; detail: string }> = {
  Configuration: {
    title: "Sign-in is not configured",
    detail:
      "lazyit could not reach its identity provider. Check the OIDC environment variables (issuer, client id and secret) and that the provider is running, then try again.",
  },
  AccessDenied: {
    title: "Access denied",
    detail:
      "Your identity provider declined the sign-in. Your account may not be permitted to access this lazyit instance — contact your administrator.",
  },
  Verification: {
    title: "Sign-in link expired",
    detail:
      "The sign-in request could not be verified or has expired. Start the sign-in again.",
  },
  Default: {
    title: "Couldn't complete sign-in",
    detail:
      "Something went wrong while signing you in. Please try again; if it keeps happening, contact your administrator.",
  },
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
  const destination = callbackUrl ?? "/dashboard";

  // Already signed in → skip the login screen.
  if (await auth()) {
    redirect(destination);
  }

  const unconfigured = await instanceIsUnconfigured();
  const errorCopy = error ? (ERROR_COPY[error] ?? ERROR_COPY.Default) : null;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Sign in to lazyit</CardTitle>
        <CardDescription>
          You will be redirected to your organization&apos;s identity provider to
          authenticate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorCopy && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <ExclamationTriangleIcon className="size-5 shrink-0 text-destructive" />
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">{errorCopy.title}</p>
              <p className="text-muted-foreground">{errorCopy.detail}</p>
            </div>
          </div>
        )}

        {unconfigured ? (
          <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <WrenchScrewdriverIcon className="size-5 shrink-0 text-primary" />
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">
                This instance isn&apos;t set up yet
              </p>
              <p className="text-muted-foreground">
                No administrator exists, so there is no one to sign in. Run the
                one-time setup to create the first administrator.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            lazyit uses your organization&apos;s single sign-on (SSO). No
            separate password is needed.
          </p>
        )}
      </CardContent>
      <CardFooter className="flex-col gap-2">
        {unconfigured ? (
          <Button asChild className="w-full">
            <Link href="/setup">Set up lazyit</Link>
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
              Sign in with your organization
            </Button>
          </form>
        )}
      </CardFooter>
    </Card>
  );
}
