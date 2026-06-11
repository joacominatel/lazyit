"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
 * First-run setup wizard (ADR-0043 Phase 3 §5c / §7a). A short full-screen flow whose steps adapt to
 * the chosen IdP:
 *   - Bundled Zitadel (happy path): Welcome → Administrator → Done (the "Configure" step is a no-op —
 *     the sidecar already provisioned the project/app — so it is dropped to keep first-run short).
 *   - BYOI (bring your own OIDC): Welcome → Configure → Administrator → Done (the Configure step
 *     re-shows the three env vars so the operator can confirm them before creating the first ADMIN).
 *
 * Driven by `GET /config/status`. Once `isConfigured` (an ADMIN exists), the wizard SELF-LOCKS: it
 * redirects to /login (which forwards an already-signed-in operator to the dashboard), so a
 * configured instance can never re-run setup. The CSRF token from the status payload is threaded
 * into the create-admin POST. The final "Done" CTA closes the loop by sending the operator to /login
 * so they can sign in as the ADMIN they just created.
 */

/** Logical step ids — render order, not contiguous numbers (the visible step list adapts per path). */
type StepId = "welcome" | "configure" | "admin" | "done";

export function SetupWizard() {
  const router = useRouter();
  const { data: status, isLoading, isError, error, refetch } = useConfigStatus();

  const [step, setStep] = useState<StepId>("welcome");
  // The operator's explicit IdP pick, if any. Until they pick, the effective choice DERIVES from the
  // server-detected integration mode (computed below) — so the radio pre-selects the posture the
  // instance is actually wired for without a setState-in-effect. The choice only drives copy/guidance;
  // the backend authoritatively reports the real mode.
  const [userChoice, setUserChoice] = useState<IdpChoice | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  const detectedChoice: IdpChoice =
    status?.integrationMode === "generic-oidc" ? "byoi" : "zitadel";
  const idpChoice: IdpChoice = userChoice ?? detectedChoice;

  // The bundled-Zitadel path drops the no-op "Configure" step; BYOI keeps it. The step list is
  // derived from the live choice so the progress indicator and the Back/Continue jumps agree.
  const steps = useMemo<{ id: StepId; label: string }[]>(() => {
    const middle: { id: StepId; label: string }[] =
      idpChoice === "byoi" ? [{ id: "configure", label: "Configure" }] : [];
    return [
      { id: "welcome", label: "Welcome" },
      ...middle,
      { id: "admin", label: "Administrator" },
      { id: "done", label: "Done" },
    ];
  }, [idpChoice]);

  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.id === step),
  );
  const goTo = (id: StepId) => setStep(id);
  const goNext = () => {
    const next = steps[currentIndex + 1];
    if (next) setStep(next.id);
  };
  const goBack = () => {
    const prev = steps[currentIndex - 1];
    if (prev) setStep(prev.id);
  };

  // Self-lock: a configured instance must never show the wizard. Redirect to /login (which bounces an
  // already-signed-in operator straight to the dashboard). We do NOT redirect while on the final
  // "Done" step (they just configured it — the redirect there is an explicit button so the success
  // state is seen).
  useEffect(() => {
    if (status?.isConfigured && step !== "done") {
      router.replace("/login");
    }
  }, [status?.isConfigured, step, router]);

  if (isLoading) {
    return (
      <Card className="w-full">
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
      <Card className="w-full">
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
  if (status.isConfigured && step !== "done") {
    return (
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CheckCircleIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
            <CardTitle>Already set up</CardTitle>
          </div>
          <CardDescription>
            This instance already has an administrator. Taking you to sign in…
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
    goTo("done");
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Set up lazyit</CardTitle>
        <CardDescription>
          A few quick steps to get your instance ready. This runs once.
        </CardDescription>
        <WizardSteps
          labels={steps.map((s) => s.label)}
          current={currentIndex + 1}
        />
      </CardHeader>

      {step === "welcome" && (
        <StepWelcome
          choice={idpChoice}
          onChoiceChange={setUserChoice}
          onNext={goNext}
        />
      )}

      {step === "configure" && (
        <StepConfigure choice={idpChoice} onBack={goBack} onNext={goNext} />
      )}

      {step === "admin" && (
        <StepCreateAdmin
          csrfToken={status.csrfToken}
          requiresAdminPassword={status.requiresAdminPassword}
          onBack={goBack}
          onCreated={handleAdminCreated}
          onError={(err) => notifyError(err, "Couldn't create the administrator")}
        />
      )}

      {step === "done" && (
        <StepDone
          email={createdEmail}
          onFinish={() => router.replace("/login")}
        />
      )}
    </Card>
  );
}
