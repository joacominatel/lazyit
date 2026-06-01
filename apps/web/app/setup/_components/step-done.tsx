import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";

/**
 * Step 4 — done (ADR-0043 §7a step 4). Confirms the first administrator was created and sends the
 * operator to the dashboard. The finish handler invalidated `GET /users/me` already (in the setup
 * mutation), so the new ADMIN's controls light up immediately on first sign-in.
 */
export function StepDone({
  email,
  onFinish,
}: {
  email: string | null;
  onFinish: () => void;
}) {
  return (
    <>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircleIcon className="size-12 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-1">
            <p className="text-base font-medium text-foreground">
              You&apos;re all set
            </p>
            <p className="text-sm text-muted-foreground">
              {email ? (
                <>
                  <span className="font-medium text-foreground">{email}</span>{" "}
                  is now the administrator. Sign in through your identity
                  provider to start using lazyit.
                </>
              ) : (
                "Your administrator account is ready. Sign in to start using lazyit."
              )}
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={onFinish}>Go to dashboard</Button>
      </CardFooter>
    </>
  );
}
