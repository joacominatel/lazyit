import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getAiConfig } from "@/lib/api/endpoints/ai-config";
import { aiConfigKeys } from "@/lib/api/hooks/use-ai-config";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { AiSettingsView } from "./_components/ai-settings-view";

/**
 * Settings → AI (ADR-0097; docs/ai-assistant/frontend.md §5.1; ADR-0067 server-prefetch route). A thin
 * Server Component prefetching the primary read, `GET /config/ai`, under the hook's exact key so the
 * wizard or editor hydrates without a waterfall. A non-admin's prefetch fails (403) and is swallowed by
 * `prefetchQuery`; the client `AdminGate` then shows its explanation. `?enabled=1` is where the wizard
 * lands after its hard reload, and shows the "AI is on" confirmation.
 */
export default async function AiSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, params] = await Promise.all([auth(), searchParams]);
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: aiConfigKeys.single(),
    queryFn: () => getAiConfig(session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AiSettingsView justEnabled={params.enabled === "1"} />
    </HydrationBoundary>
  );
}
