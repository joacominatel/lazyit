import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AccountAiView } from "./_components/account-ai-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("oauth.account");
  return { title: t("title") };
}

/**
 * `/account/ai` — "AI & connected apps" (ADR-0097, issue #1315). A thin Server Component rendering the
 * client {@link AccountAiView}. Any signed-in user reaches the route and lists their own connections;
 * connecting a new app needs `ai:connect`, which the API enforces (AUD-083).
 *
 * ponytail: no server prefetch (ADR-0067). Every read here is self-scope and the install panel depends
 * on the instance's MCP mode, so a prefetch would fetch what many callers never see;
 * the page is a settings surface with no first-paint content worth the server round trip.
 */
export default function AccountAiPage() {
  return <AccountAiView />;
}
