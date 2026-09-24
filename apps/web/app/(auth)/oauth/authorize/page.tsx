import type { OAuthAuthorizeValidation } from "@lazyit/shared";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { validateAuthorizeRequest } from "@/lib/api/endpoints/oauth";
import { loginCallbackPath } from "@/lib/auth/login-callback";
import { expiredSessionLoginPath } from "@/lib/auth/session-expiry";

import {
  classifyValidateError,
  type RawSearchParams,
  readAuthorizeParams,
  type ValidateFailure,
} from "./_lib/consent";
import { ConsentForm } from "./_components/consent-form";
import { ConsentMessage } from "./_components/consent-message";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("oauth.consent");
  return { title: t("pageTitle"), robots: { index: false, follow: false } };
}

/** The page's own path and query, rebuilt from its search params (for the sign-in round trip). */
function selfLocation(raw: RawSearchParams): { pathname: string; search: string } {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, v);
    }
  }
  const search = query.toString();
  return { pathname: "/oauth/authorize", search: search ? `?${search}` : "" };
}

/** A printable host for a redirect target (a custom scheme has no host: show the scheme). */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol;
  } catch {
    return url;
  }
}

/**
 * `/oauth/authorize` — the OAuth 2.1 authorization endpoint of lazyit's MCP server, rendered as the
 * consent page (ADR-0097; docs/ai-assistant/mcp-and-oauth.md §5.2, §12; frontend.md Fork H, §5.3). In the
 * `(auth)` group: the AuthShell, no app chrome, nothing to distract from a security decision.
 *
 * Server side it requires a session (route protection sends a signed-out visitor to /login with this
 * URL, query included, as `callbackUrl`), then forwards the raw OAuth parameters to
 * `POST /oauth/authorize/validate` with the session's token. A refusal, an unknown client or redirect, a
 * malformed request, or an instance without an authorization server renders an explanation — this page
 * never redirects to a client by itself. Framing is denied app-wide (next.config.ts).
 */
export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const location = selfLocation(raw);
  const session = await auth();
  if (!session?.accessToken) redirect(loginCallbackPath(location));

  const read = readAuthorizeParams(raw);
  if (!read.ok) return <ConsentMessage stop={{ kind: "invalid-request" }} />;
  const { params } = read;

  let validation: OAuthAuthorizeValidation | null = null;
  let failure: ValidateFailure | null = null;
  try {
    validation = await validateAuthorizeRequest(params, session.accessToken);
  } catch (error) {
    failure = classifyValidateError(error, params.redirect_uri);
  }

  if (failure) {
    switch (failure.kind) {
      case "auth":
        // The API refused the session's token: sign in again, then come back here.
        redirect(expiredSessionLoginPath(location));
      case "password-change":
        redirect("/change-password");
      case "client-error":
        return (
          <ConsentMessage
            stop={{ ...failure, host: hostOf(failure.redirectTo) }}
          />
        );
      default:
        return <ConsentMessage stop={failure} />;
    }
  }

  if (!validation) return <ConsentMessage stop={{ kind: "unknown" }} />;
  if (!validation.ok) {
    return (
      <ConsentMessage stop={{ kind: "refusal", refusal: validation.refusal }} />
    );
  }

  return <ConsentForm consent={validation} params={params} />;
}
