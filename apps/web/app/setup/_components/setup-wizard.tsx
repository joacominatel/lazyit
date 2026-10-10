"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
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
import { StepConfigure } from "./step-configure";
import { StepCreateAdmin } from "./step-create-admin";
import { StepDone } from "./step-done";
import { StepWelcome } from "./step-welcome";
import { idpChoiceFor, type StepId, stepsFor } from "./wizard-flow";
import { WizardSteps } from "./wizard-steps";

/**
 * First-run setup wizard (ADR-0043 §5c / §7a, ADR-0086 §6, ADR-0102). A short full-screen flow whose
 * steps follow the server-reported auth mode:
 *   - Local accounts: Welcome → Administrator → Done.
 *   - Your own OIDC provider: Welcome → Configure → Administrator → Done (the Configure step re-shows the
 *     environment variables so the operator can confirm them before creating the first ADMIN).
 *
 * Driven by `GET /config/status`. Once `isConfigured` (an ADMIN exists), the wizard SELF-LOCKS: it
 * redirects to /login (which forwards an already-signed-in operator to the dashboard), so a
 * configured instance can never re-run setup. The CSRF token from the status payload is threaded
 * into the create-admin POST. The final "Done" CTA closes the loop by sending the operator to /login
 * so they can sign in as the ADMIN they just created.
 */
export function SetupWizard() {
  const t = useTranslations("setup");
  const router = useRouter();
  const { data: status, isLoading, isError, error, refetch } = useConfigStatus();

  const [step, setStep] = useState<StepId>("welcome");
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  const idpChoice = idpChoiceFor(status?.integrationMode);
  const steps = useMemo(() => {
    const labels: Record<StepId, string> = {
      welcome: t("steps.welcome"),
      configure: t("steps.configure"),
      admin: t("steps.admin"),
      done: t("steps.done"),
    };
    return stepsFor(idpChoice).map((id) => ({ id, label: labels[id] }));
  }, [idpChoice, t]);

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
            <CardTitle>{t("error.title")}</CardTitle>
          </div>
          <CardDescription>{t("error.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestIdNote requestId={requestId} />
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => refetch()}>
            <ArrowPathIcon />
            {t("error.retry")}
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
            <CheckCircleIcon className="size-5 text-success" />
            <CardTitle>{t("alreadySetUp.title")}</CardTitle>
          </div>
          <CardDescription>{t("alreadySetUp.description")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function handleAdminCreated(email: string) {
    setCreatedEmail(email);
    toast.success(t("toast.adminCreated"));
    goTo("done");
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
        <WizardSteps
          labels={steps.map((s) => s.label)}
          current={currentIndex + 1}
        />
      </CardHeader>

      {step === "welcome" && (
        <StepWelcome choice={idpChoice} onNext={goNext} />
      )}

      {step === "configure" && (
        <StepConfigure onBack={goBack} onNext={goNext} />
      )}

      {step === "admin" && (
        <StepCreateAdmin
          csrfToken={status.csrfToken}
          requiresAdminPassword={status.requiresAdminPassword}
          onBack={goBack}
          onCreated={handleAdminCreated}
          onError={(err) => notifyError(err, t("toast.adminCreateError"))}
        />
      )}

      {step === "done" && (
        <StepDone
          email={createdEmail}
          isLocal={idpChoice === "local"}
          onFinish={() => router.replace("/login")}
        />
      )}
    </Card>
  );
}
