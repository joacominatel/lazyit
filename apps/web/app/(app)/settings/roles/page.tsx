import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getPermissionMatrix } from "@/lib/api/endpoints/config";
import { permissionConfigKeys } from "@/lib/api/hooks/use-permissions-config";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { RolesMatrixView } from "./_components/roles-matrix-view";

/**
 * Settings → Roles & permissions (RBAC v2, ADR-0046; #1540; ADR-0067 server-prefetch route). One page:
 * the role × capability matrix. A thin Server Component that prefetches the editable role→permission
 * matrix under the hook's exact key (`permissionConfigKeys.matrix()`), so the client
 * {@link RolesMatrixView} hydrates without a skeleton → fetch waterfall. The client `AdminGate` stays
 * inside the view; the API's `settings:manage` guard is the real boundary. The old per-role screen,
 * `/settings/roles/permissions`, now redirects here.
 */
export default async function RolesPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: permissionConfigKeys.matrix(),
    queryFn: () => getPermissionMatrix(session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <RolesMatrixView />
    </HydrationBoundary>
  );
}
