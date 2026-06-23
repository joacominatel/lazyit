import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getServiceAccounts } from "@/lib/api/endpoints/service-accounts";
import { serviceAccountKeys } from "@/lib/api/hooks/use-service-accounts";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ServiceAccountsView } from "./_components/service-accounts-view";

/**
 * Settings → Service accounts (ADR-0048; ADR-0067 server-prefetch route). A thin Server Component
 * that prefetches the live (non-revoked) service-account list so the {@link ServiceAccountsManager}'s
 * `useServiceAccounts(false)` hydrates without a skeleton → fetch waterfall. The prefetched key
 * matches the hook exactly: `serviceAccountKeys.list(false)`. The client `AdminGate` stays inside the
 * wrapped view (the API's `settings:manage` guard is the real boundary; the #600 401 handler stays on
 * the client provider). See the applications page for the full mold.
 */
export default async function ServiceAccountsPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: serviceAccountKeys.list(false),
    queryFn: () => getServiceAccounts(false, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ServiceAccountsView />
    </HydrationBoundary>
  );
}
