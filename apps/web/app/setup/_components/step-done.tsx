import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";

/**
 * Final step — done (ADR-0043 §7a). Confirms the first administrator was created and closes the loop
 * by sending the operator to /login to sign in as that ADMIN (the new account does not have a session
 * yet — it must authenticate through the IdP first). The finish handler already invalidated
 * `GET /users/me` (in the setup mutation), so the ADMIN's controls light up immediately on first
 * sign-in.
 */
export function StepDone({
  email,
  onFinish,
}: {
  email: string | null;
  onFinish: () => void;
}) {
  const t = useTranslations("setup.done");
  return (
    <>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircleIcon className="size-12 text-success" />
          <div className="space-y-1">
            <p className="text-base font-medium text-foreground">{t("title")}</p>
            <p className="text-sm text-muted-foreground">
              {email
                ? t.rich("bodyWithEmail", {
                    email: () => (
                      <span className="font-medium text-foreground">
                        {email}
                      </span>
                    ),
                  })
                : t("bodyWithoutEmail")}
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={onFinish}>{t("finish")}</Button>
      </CardFooter>
    </>
  );
}
