import { signIn } from "@/auth";
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
 * BYOI: the IdP label ("Your organization") comes from the provider `name` in
 * auth.ts. Operators with a branded IdP can change it there — no UI code to touch.
 */
export default function LoginPage() {
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
            await signIn("oidc");
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
