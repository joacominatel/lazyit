import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AccountHubView } from "./_components/account-hub-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account.hub");
  return { title: t("title") };
}

/**
 * `/account` — the account hub (issue #1404): the signed-in user's own "me" page. A thin Server
 * Component rendering the client {@link AccountHubView}; any signed-in user reaches it.
 *
 * ponytail: no server prefetch (ADR-0067). The only reads are the app-wide warmed `GET /users/me` and
 * `GET /config/status`, plus the self-scope `GET /ai/status` gate — nothing worth a server round trip.
 */
export default function AccountPage() {
  return <AccountHubView />;
}
