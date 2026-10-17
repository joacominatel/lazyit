import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { ByoiSnippet } from "./byoi-snippet";

/**
 * Step 2 — OIDC mode only (ADR-0043 §7a step 2, ADR-0102). Re-shows the environment variables so the
 * operator can confirm they are set before creating the first administrator, whose email must exist
 * in their IdP to sign in.
 */
export function StepConfigure({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("setup.configure");
  return (
    <>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("byoiConfirm")}</p>
        <ByoiSnippet />
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
