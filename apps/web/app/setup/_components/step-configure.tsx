import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import type { IdpChoice } from "./types";
import { ByoiSnippet } from "./byoi-snippet";

/**
 * Step 2 — optional config (ADR-0043 §7a step 2). For the bundled-Zitadel path this is informational
 * and skippable: the zitadel-bootstrap sidecar (the other lane) already provisioned the project/app,
 * so there is nothing to enter here — we only reassure that Zitadel may still be initializing. For
 * BYOI we re-show the three env vars so the operator can confirm they are set before creating the
 * first administrator (whose email must exist in their IdP to sign in).
 */
export function StepConfigure({
  choice,
  onBack,
  onNext,
}: {
  choice: IdpChoice;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("setup.configure");
  return (
    <>
      <CardContent className="space-y-4">
        {choice === "zitadel" ? (
          <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
            <InformationCircleIcon className="size-5 shrink-0 text-primary" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-foreground">
                {t("zitadelReadyTitle")}
              </p>
              <p className="text-muted-foreground">{t("zitadelReadyBody")}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("byoiConfirm")}</p>
            <ByoiSnippet />
          </>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("back")}
        </Button>
        <Button onClick={onNext}>{t("continue")}</Button>
      </CardFooter>
    </>
  );
}
