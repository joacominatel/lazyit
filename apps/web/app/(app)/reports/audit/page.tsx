import type { Metadata } from "next";
import { AuditGate } from "./_components/audit-gate";

/**
 * Security audit log (issue #871, ADR-0081) — the in-app read + filtered CSV export of the three
 * security audit logs (secret / permission / service-account) at `/reports/audit`. A sibling of the
 * Reports activity feed, sharing the SAME `logs:read` gate. Client-gated in {@link AuditGate}; the read
 * is source-scoped so there is no single first-paint page to server-prefetch (the client fetches on
 * mount) — unlike the Reports feed, this trades the prefetch for a simpler surface.
 */
export const metadata: Metadata = { title: "Audit log" };

export default function AuditPage() {
  return <AuditGate />;
}
