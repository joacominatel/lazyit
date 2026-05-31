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

/**
 * Sign-in page — redirects the user to the configured OIDC provider.
 *
 * Auth.js v5 handles the full OIDC flow (authorization code + PKCE):
 *   1. User clicks "Sign in"
 *   2. Auth.js redirects to the IdP (Zitadel by default — ADR-0037)
 *   3. IdP authenticates and redirects back to /api/auth/callback/oidc
 *   4. Auth.js stores the session cookie (JWT, ADR-0039) and redirects to the app
 *
 * The layout (auth)/layout.tsx provides the centered card container.
 *
 * Redirect handling: `proxy.ts` sends unauthenticated visitors here with a
 * `callbackUrl` query param (their intended destination). We forward that to
 * `signIn` via `redirectTo` so a successful login lands in the app, and we
 * bounce already-authenticated visitors straight there (default `/dashboard`).
 *
 * BYOI: the IdP label ("Your organization") comes from the provider `name` in
 * auth.ts. Operators with a branded IdP can change it there — no UI code to touch.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  const destination = callbackUrl ?? "/dashboard";

  // Already signed in → skip the login screen.
  if (await auth()) {
    redirect(destination);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to lazyit</CardTitle>
        <CardDescription>
          You will be redirected to your organization&apos;s identity provider to
          authenticate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          lazyit uses your organization&apos;s single sign-on (SSO). No
          separate password is needed.
        </p>
      </CardContent>
      <CardFooter>
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
      </CardFooter>
    </Card>
  );
}
