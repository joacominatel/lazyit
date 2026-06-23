import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getPermissionMatrix } from "@/lib/api/endpoints/config";
import { permissionConfigKeys } from "@/lib/api/hooks/use-permissions-config";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { PermissionsEditorView } from "./_components/permissions-editor-view";

/**
 * Settings → Roles → Role permissions (RBAC v2 P7, ADR-0046; ADR-0067 server-prefetch route). A thin
 * Server Component that prefetches the editable role→permission matrix so the client
 * {@link PermissionsEditorView}'s `usePermissionMatrix()` hydrates without a skeleton → fetch
 * waterfall. The prefetched key matches the hook exactly: `permissionConfigKeys.matrix()` =
 * `["permissions-config","matrix"]`. The client `AdminGate` + `Suspense` (the `?role=` deep-link reads
 * `useSearchParams`) stay inside the wrapped view: the API's `settings:manage` guard is the real
 * boundary, and the #600 401 handler stays on the client provider. See the applications page for the
 * full mold.
 */
export default async function RolePermissionsPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: permissionConfigKeys.matrix(),
    queryFn: () => getPermissionMatrix(session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PermissionsEditorView />
    </HydrationBoundary>
  );
}
