import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { OAuthAuthorizeRefusal } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Every reason the consent page stops without showing a consent screen. */
export type ConsentStop =
  | { kind: "refusal"; refusal: OAuthAuthorizeRefusal }
  | { kind: "unavailable" }
  | { kind: "invalid-request" }
  | { kind: "client-error"; error: string; redirectTo: string; host: string }
  | { kind: "unsafe-redirect" }
  | { kind: "unknown"; requestId?: string };

function messageKey(stop: ConsentStop): string {
  switch (stop.kind) {
    case "refusal":
      return `refusal.${stop.refusal}`;
    case "unavailable":
      return "unavailable";
    case "invalid-request":
      return "invalidRequest";
    case "client-error":
      return "clientError";
    case "unsafe-redirect":
      return "unsafeRedirect";
    default:
      return "unknown";
  }
}

/**
 * Why the consent page cannot continue. Never redirects on its own: an invalid client or redirect is an
 * error page (RFC 6749 §4.1.2.1), and even a request error that belongs to the client is only OFFERED as
 * a link back, naming the host it goes to — an explicit click, never an automatic redirect.
 * Usable from the Server Component page and the client consent form alike.
 */
export function ConsentMessage({ stop }: { stop: ConsentStop }) {
  const t = useTranslations("oauth.consent.stop");
  const key = messageKey(stop);

  return (
    <Card className="w-full animate-rise-in shadow-e2">
      <CardHeader>
        <div className="flex items-start gap-3">
          <ExclamationTriangleIcon
            className="mt-0.5 size-5 shrink-0 text-warning"
            aria-hidden
          />
          <div className="space-y-1.5">
            <CardTitle className="font-display">{t(`${key}.title`)}</CardTitle>
            <CardDescription>{t(`${key}.body`)}</CardDescription>
          </div>
        </div>
      </CardHeader>
      {stop.kind === "client-error" ? (
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            {t("clientError.code")}{" "}
            <span className="font-mono">{stop.error}</span>
          </p>
          <p className="text-muted-foreground">
            {t("clientError.destination")}{" "}
            <span className="font-mono font-medium text-foreground">
              {stop.host}
            </span>
          </p>
        </CardContent>
      ) : null}
      {stop.kind === "unknown" && stop.requestId ? (
        <CardContent className="text-xs text-muted-foreground">
          {t("unknown.requestId")}{" "}
          <span className="font-mono">{stop.requestId}</span>
        </CardContent>
      ) : null}
      <CardFooter className="flex flex-wrap justify-end gap-2">
        {stop.kind === "unavailable" ? (
          <Button asChild variant="outline">
            <Link href="/account/ai">{t("unavailable.action")}</Link>
          </Button>
        ) : null}
        {stop.kind === "client-error" ? (
          <Button asChild variant="outline">
            {/* A plain anchor: the target may be a loopback or custom-scheme address. */}
            <a href={stop.redirectTo} rel="noreferrer">
              {t("clientError.action", { host: stop.host })}
            </a>
          </Button>
        ) : null}
        <Button asChild>
          <Link href="/dashboard">{t("backToLazyit")}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
