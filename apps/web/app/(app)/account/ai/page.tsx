import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AccountAiView } from "./_components/account-ai-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("oauth.account");
  return { title: t("title") };
}

/**
 * `/account/ai` — "AI & connected apps" (ADR-0097, issue #1315). A thin Server Component rendering the
 * client {@link AccountAiView}. Any signed-in user reaches the route; the view shows its content to
 * holders of `ai:connect` and the API enforces it.
 *
 * ponytail: no server prefetch (ADR-0067). Every read here is self-scope and gated client-side on
 * `ai:connect` and on the instance's MCP mode, so a prefetch would fetch for callers who never see it;
 * the page is a settings surface with no first-paint content worth the server round trip.
 */
export default function AccountAiPage() {
  return <AccountAiView />;
}
