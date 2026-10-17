import { KeyIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import type { IdpChoice } from "./types";
import { ByoiSnippet } from "./byoi-snippet";

/**
 * Step 1 — Welcome (ADR-0043 §7a step 1, ADR-0102). The auth mode is fixed at deploy time, so there is
 * nothing to pick: one card explains the mode, and in OIDC mode the environment snippet follows it.
 */
export function StepWelcome({
  choice,
  onNext,
}: {
  choice: IdpChoice;
  onNext: () => void;
}) {
  const t = useTranslations("setup.welcome");
  const isLocal = choice === "local";
  const Icon = isLocal ? LockClosedIcon : KeyIcon;

  return (
    <>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <Icon className="size-6 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {isLocal ? t("local.title") : t("byoi.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {isLocal ? t("local.body") : t("byoi.body")}
            </p>
          </div>
        </div>

        {!isLocal && <ByoiSnippet />}
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={onNext}>{t("continue")}</Button>
      </CardFooter>
    </>
  );
}
