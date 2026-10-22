import type { GrantProvisioning, MyAccessRequest } from "@lazyit/shared";
import type { StatusTone } from "@/components/ui/status-badge";

/**
 * The coarse provisioning status a requester sees on their own grants and approved requests (#1700).
 * The API derives it from the latest provisioning run; the web only maps it to a tone (ADR-0077):
 * nothing to do is neutral, work in flight is info, done is success and "IT has to act" is warning.
 */
export const PROVISIONING_TONE: Record<GrantProvisioning, StatusTone> = {
  NONE: "neutral",
  IN_PROGRESS: "info",
  DONE: "success",
  WAITING_ON_IT: "warning",
};

/**
 * The status to show on one of the caller's request rows, or null for none: only an APPROVED request
 * has a grant to provision, and an API that predates the field sends nothing.
 */
export function requestProvisioning(
  request: Pick<MyAccessRequest, "status" | "provisioning">,
): GrantProvisioning | null {
  if (request.status !== "APPROVED") return null;
  return request.provisioning ?? null;
}
