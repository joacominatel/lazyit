import { AccessRequestsView } from "./_components/access-requests-view";

/**
 * `/applications/access-requests` — the admin review queue for pending AccessRequests (ADR-0085, Part
 * 2 of #948). A static route segment, so it takes precedence over the sibling `[id]` dynamic route
 * (no collision). The `accessRequest:read` gate lives client-side in {@link AccessRequestsView} (the
 * API's `@RequirePermission` guard is the real gate); no server prefetch — the queue is a low-traffic
 * admin surface.
 */
export default function AccessRequestsPage() {
  return <AccessRequestsView />;
}
