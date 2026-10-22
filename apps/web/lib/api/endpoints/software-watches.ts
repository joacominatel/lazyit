import type {
  CreateSoftwareWatch,
  SoftwareWatch,
  SoftwareWatchHostPage,
  SoftwareWatchSummary,
} from "@lazyit/shared";
import { type SoftwareWatchBucket, softwareWatchHostsQuery } from "@/lib/agent/software-watch";
import { apiFetch } from "../client";

/**
 * Data access for the software watchlist (#1684) — `/infra/software-watches`.
 *
 * Reads are `infra:read`; add and remove are `infra:manage` and HUMAN-ONLY server-side (a service
 * account's token gets a 403). The responses are not re-parsed here: like the fleet read next door,
 * the read stays tolerant and the shared types describe the shape.
 */
const BASE = "/infra/software-watches";

/** Every live watch with its distribution, oldest first (bounded by `SOFTWARE_WATCH_LIMIT`). */
export function getSoftwareWatches(signal?: AbortSignal): Promise<SoftwareWatchSummary[]> {
  return apiFetch<SoftwareWatchSummary[]>(BASE, { signal });
}

/** One page of the hosts behind one bucket of one watch. */
export function getSoftwareWatchHosts(
  watchId: string,
  bucket: SoftwareWatchBucket,
  offset: number,
  signal?: AbortSignal,
): Promise<SoftwareWatchHostPage> {
  return apiFetch<SoftwareWatchHostPage>(
    `${BASE}/${encodeURIComponent(watchId)}/hosts?${softwareWatchHostsQuery(bucket, offset)}`,
    { signal },
  );
}

/** Add a name. The server normalizes it; 409 on a live duplicate, 400 at the cap. */
export function createSoftwareWatch(body: CreateSoftwareWatch): Promise<SoftwareWatch> {
  return apiFetch<SoftwareWatch>(BASE, { method: "POST", body });
}

/** Remove a watch (soft delete). Nothing about any host changes. */
export function deleteSoftwareWatch(watchId: string): Promise<SoftwareWatch> {
  return apiFetch<SoftwareWatch>(`${BASE}/${encodeURIComponent(watchId)}`, {
    method: "DELETE",
  });
}
