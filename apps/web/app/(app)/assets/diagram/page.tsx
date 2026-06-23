import { DiagramView } from "./_components/diagram-view";

/**
 * Assets › Diagram — the infra topology canvas (ADR-0070 §6, issue #741). Unlike the Assets list
 * (an SSR-prefetch pilot), this route does NOT prefetch: React Flow is client-only and the canvas
 * fetches its nodes/edges client-side via TanStack Query. The thin Server Component just mounts the
 * client view. The API gates `/infra/*` behind `infra:read` server-side; the nav link is hidden for
 * callers without it.
 */
export default function DiagramPage() {
  return <DiagramView />;
}
