import { ServersListView } from "./_components/servers-list-view";

/**
 * Assets › Servers — the filtered LIST view of infra topology nodes (ADR-0070 §6, issue #743). The
 * sibling of Assets › Diagram (the canvas): same data, a scannable table instead of a board. Like the
 * Diagram route this does NOT SSR-prefetch — the infra reads are client-only (TanStack Query), so the
 * thin Server Component just mounts the client view. The API gates `/infra/*` behind `infra:read`
 * server-side; the nav link is hidden for callers without it.
 */
export default function ServersPage() {
  return <ServersListView />;
}
