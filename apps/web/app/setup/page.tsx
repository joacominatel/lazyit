import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { SetupWizard } from "./_components/setup-wizard";

export const metadata: Metadata = {
  title: "Set up lazyit",
};

/**
 * First-run setup route (ADR-0043 Phase 3 §5c). Full-screen, no sidebar — lives OUTSIDE the (app)
 * group so it is reachable before any login exists (no ADMIN → no session). The first-run gate in
 * proxy.ts routes a fresh operator here; the wizard reads `GET /config/status` and self-locks once
 * the instance is configured.
 *
 * Shares the AuthShell (wordmark + theme toggle + centered column) with the (auth) login surface so
 * the two never diverge; the wizard is wider than login, hence the `max-w-xl` content width.
 *
 * Server component shell only; the interactive 4-step flow is the SetupWizard client component.
 */
export default function SetupPage() {
  return (
    <AuthShell contentClassName="max-w-xl">
      <SetupWizard />
    </AuthShell>
  );
}
