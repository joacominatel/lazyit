import type { Metadata } from "next";
import { SetupWizard } from "./_components/setup-wizard";

export const metadata: Metadata = {
  title: "Set up lazyit",
};

/**
 * First-run setup route (ADR-0043 Phase 3 §5c). Full-screen, no sidebar — lives OUTSIDE the (app)
 * group so it is reachable before any login exists (no ADMIN → no session). The wizard reads
 * `GET /config/status` and self-locks (redirects to /dashboard) once the instance is configured.
 *
 * Server component shell only; the interactive 4-step flow is the SetupWizard client component.
 */
export default function SetupPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <SetupWizard />
    </main>
  );
}
