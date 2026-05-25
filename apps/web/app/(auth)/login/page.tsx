import Link from "next/link";
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

// Placeholder only. Authentication is deferred and will be an external IdP (OIDC)
// integration — there is no real sign-in flow here. See ADR-0016.
export default function LoginPage() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to lazyit</CardTitle>
        <CardDescription>Authentication is not wired up yet.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input type="email" placeholder="you@company.com" disabled />
        <Input type="password" placeholder="Password" disabled />
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        <Button className="w-full" disabled>
          Sign in
        </Button>
        <Button variant="ghost" size="sm" asChild className="w-full">
          <Link href="/dashboard">Continue to dashboard (dev)</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
