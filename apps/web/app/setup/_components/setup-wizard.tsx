"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";
import { notifyError } from "@/lib/api/notify-error";
import type { IdpChoice } from "./types";
import { StepConfigure } from "./step-configure";
import { StepCreateAdmin } from "./step-create-admin";
import { StepDone } from "./step-done";
import { StepWelcome } from "./step-welcome";
import { WizardSteps } from "./wizard-steps";

/**
 * First-run setup wizard (ADR-0043 Phase 3 §5c / §7a). A 4-step full-screen flow:
 *   1. Welcome + IdP choice (bundled Zitadel vs. BYOI, with the 3-env-var snippet for BYOI).
 *   2. Optional config / "Zitadel is initializing" status (skippable; the sidecar already provisioned).
 *   3. Create the first ADMIN (email + name; role locked to ADMIN).
 *   4. Done → go to the dashboard.
 *
 * Driven by `GET /config/status`. Once `isConfigured` (an ADMIN exists), the wizard SELF-LOCKS: it
 * redirects to /dashboard, so a configured instance can never re-run setup. The CSRF token from the
 * status payload is threaded into the create-admin POST.
 */
const TOTAL_STEPS = 4;

export function SetupWizard() {
  const router = useRouter();
  const { data: status, isLoading, isError, error, refetch } = useConfigStatus();

  const [step, setStep] = useState(1);
  // The operator's explicit IdP pick, if any. Until they pick, the effective choice DERIVES from the
  // server-detected integration mode (computed below) — so the radio pre-selects the posture the
  // instance is actually wired for without a setState-in-effect. The choice only drives copy/guidance;
  // the backend authoritatively reports the real mode.
  const [userChoice, setUserChoice] = useState<IdpChoice | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  const detectedChoice: IdpChoice =
    status?.integrationMode === "generic-oidc" ? "byoi" : "zitadel";
  const idpChoice: IdpChoice = userChoice ?? detectedChoice;

  // Self-lock: a configured instance must never show the wizard. Redirect to the dashboard. We do
  // NOT redirect while the user is on the final "Done" step (they just configured it — the redirect
  // there is an explicit button so the success state is seen).
  useEffect(() => {
    if (status?.isConfigured && step < 4) {
      router.replace("/dashboard");
    }
  }, [status?.isConfigured, step, router]);

  if (isLoading) {
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !status) {
    const requestId = error instanceof ApiError ? error.requestId : undefined;
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="flex items-center gap-2 text-destructive">
            <ExclamationTriangleIcon className="size-5" />
            <CardTitle>Couldn&apos;t reach the server</CardTitle>
          </div>
          <CardDescription>
            The setup wizard needs to talk to the lazyit API. Check that the API
            is running and reachable, then try again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RequestIdNote requestId={requestId} />
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => refetch()}>
            <ArrowPathIcon />
            Retry
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // While the redirect is in flight for an already-configured instance, show a brief notice instead
  // of flashing the wizard.
  if (status.isConfigured && step < 4) {
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CheckCircleIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
            <CardTitle>Already set up</CardTitle>
          </div>
          <CardDescription>
            This instance already has an administrator. Taking you to the
            dashboard…
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function handleAdminCreated(email: string, mirrored: boolean) {
    setCreatedEmail(email);
    toast.success(
      mirrored
        ? "Administrator created and mirrored to your IdP"
        : "Administrator created",
    );
    setStep(4);
  }

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>Set up lazyit</CardTitle>
        <CardDescription>
          A few quick steps to get your instance ready. This runs once.
        </CardDescription>
        <WizardSteps current={step} total={TOTAL_STEPS} />
      </CardHeader>

      {step === 1 && (
        <StepWelcome
          choice={idpChoice}
          onChoiceChange={setUserChoice}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <StepConfigure
          choice={idpChoice}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <StepCreateAdmin
          csrfToken={status.csrfToken}
          onBack={() => setStep(2)}
          onCreated={handleAdminCreated}
          onError={(err) => notifyError(err, "Couldn't create the administrator")}
        />
      )}

      {step === 4 && (
        <StepDone
          email={createdEmail}
          onFinish={() => router.replace("/dashboard")}
        />
      )}
    </Card>
  );
}
