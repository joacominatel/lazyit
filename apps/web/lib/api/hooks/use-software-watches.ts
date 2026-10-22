import type { CreateSoftwareWatch } from "@lazyit/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type SoftwareWatchBucket,
  softwareWatchBucketKey,
} from "@/lib/agent/software-watch";
import {
  createSoftwareWatch,
  deleteSoftwareWatch,
  getSoftwareWatches,
  getSoftwareWatchHosts,
} from "../endpoints/software-watches";
import { infraKeys } from "./use-infra-nodes";

/**
 * The software watchlist's queries (#1684). Keyed under the `infra` namespace, like the fleet read,
 * so every mutation that already invalidates `infraKeys.all` (a confirm, a merge, a discard) also
 * refreshes the distributions those hosts feed.
 *
 * Not polled: the distribution moves when a host re-reports a CHANGED package list, i.e. rarely, and
 * each read aggregates over every host. The view offers a manual refresh instead.
 */
export const softwareWatchKeys = {
  all: () => [...infraKeys.all, "software-watches"] as const,
  hosts: (watchId: string, bucket: SoftwareWatchBucket, offset: number) =>
    [
      ...softwareWatchKeys.all(),
      "hosts",
      watchId,
      softwareWatchBucketKey(bucket),
      offset,
    ] as const,
};

/** Same freshness as the fleet read: a section switch should not re-run a fleet-wide aggregate. */
const SOFTWARE_WATCH_STALE_MS = 60_000;

export function useSoftwareWatches() {
  return useQuery({
    queryKey: softwareWatchKeys.all(),
    queryFn: ({ signal }) => getSoftwareWatches(signal),
    staleTime: SOFTWARE_WATCH_STALE_MS,
  });
}

/**
 * One page of a drill-in. `keepPreviousData` holds the current page on screen while the next one
 * loads; the drill-in remounts per bucket, so a previous BUCKET's rows are never shown as this one's.
 */
export function useSoftwareWatchHosts(
  watchId: string,
  bucket: SoftwareWatchBucket,
  offset: number,
) {
  return useQuery({
    queryKey: softwareWatchKeys.hosts(watchId, bucket, offset),
    queryFn: ({ signal }) => getSoftwareWatchHosts(watchId, bucket, offset, signal),
    placeholderData: keepPreviousData,
    staleTime: SOFTWARE_WATCH_STALE_MS,
  });
}

export function useCreateSoftwareWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSoftwareWatch) => createSoftwareWatch(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: softwareWatchKeys.all() }),
  });
}

export function useDeleteSoftwareWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (watchId: string) => deleteSoftwareWatch(watchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: softwareWatchKeys.all() }),
  });
}
