import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getConfigStatus } from "@/lib/api/endpoints/config";
import { getInstanceVersion } from "@/lib/api/endpoints/instance";
import { configKeys } from "@/lib/api/hooks/use-config-status";
import { instanceKeys } from "@/lib/api/hooks/use-instance-version";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { InstanceSettingsView } from "./_components/instance-settings-view";

/**
 * Settings → Instance (ADR-0067 server-prefetch route). A thin Server Component that prefetches the
 * read-only `GET /config/status` + `GET /instance/version` (ADR-0083) payloads so the client
 * {@link InstanceSettingsView} (`useConfigStatus` / `useInstanceVersion`) hydrates without a
 * skeleton → fetch waterfall. The prefetched key matches the hook exactly:
 * `configKeys.status()` = `["config","status"]`. The client `AdminGate` stays inside the wrapped view
 * (the API's `settings:manage` guard is the real boundary; the #600 401 handler stays on the client
 * provider). See the applications page for the full mold.
 */
export default async function InstancePage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: configKeys.status(),
      queryFn: () => getConfigStatus(session?.accessToken),
    }),
    // Version identity (ADR-0083) — authenticated read; prefetch failures are swallowed by
    // prefetchQuery, so the client hook degrades to its own fetch (and the view to an em dash).
    queryClient.prefetchQuery({
      queryKey: instanceKeys.version(),
      queryFn: () => getInstanceVersion(session?.accessToken),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <InstanceSettingsView />
    </HydrationBoundary>
  );
}
