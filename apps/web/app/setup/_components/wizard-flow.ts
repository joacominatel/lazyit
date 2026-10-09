import type { IdpChoice } from "./types";

/** Logical step ids, in render order. */
export type StepId = "welcome" | "configure" | "admin" | "done";

/** Anything but `local` is OIDC — including the legacy `zitadel` an older API may still report. */
export function idpChoiceFor(integrationMode: string | undefined): IdpChoice {
  return integrationMode === "local" ? "local" : "byoi";
}

export function stepsFor(choice: IdpChoice): StepId[] {
  return choice === "byoi"
    ? ["welcome", "configure", "admin", "done"]
    : ["welcome", "admin", "done"];
}
