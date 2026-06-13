import type { CreateUserKeypair } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import {
  createKeypair,
  getMyKeypair,
  getUserPublicKey,
  resetMyKeypair,
} from "../endpoints/keypair";
import { keypairKeys } from "../query-keys";

/**
 * Read + write hooks for the per-user `UserKeypair` (ADR-0061 §3). The wire DTO posted by the create /
 * reset mutations is produced CLIENT-SIDE (`bootstrapKeypair`) — base64 blobs + metadata only. NOTHING
 * secret (passphrase, recovery key, private key) is passed to these hooks, cached, or logged: the
 * caller derives the DTO in the browser and shows the recovery key ONCE before calling create.
 */

/**
 * Retry predicate: settle immediately on 404 (first-run — no keypair yet); allow up to 3 retries
 * for genuine transient failures (5xx / network). Hoisted to module level so the function reference
 * is stable across renders and does not trigger a spurious `observerOptionsUpdated` on every mount.
 */
const keypairRetry = (failureCount: number, error: Error) =>
  !(error instanceof ApiError && error.status === 404) && failureCount < 3;

/** Fetch the caller's own keypair (public key + both wrapped private-key copies). */
export function useMyKeypair() {
  return useQuery({
    queryKey: keypairKeys.me(),
    queryFn: getMyKeypair,
    // A 404 means "this user has never bootstrapped a keypair" — the EXPECTED first-run state, NOT a
    // transient failure. The default `retry: 3` would keep the query `pending` through several backed-off
    // retries (hanging the bootstrap/unlock UI on a spinner and spamming GET /keypair/me), so the page
    // never flips to the bootstrap surface. Settle to error IMMEDIATELY on 404 so `isMissing` is true at
    // once and the bootstrap form renders; keep the default retries for genuine transient errors (5xx/network).
    retry: keypairRetry,
    // An errored 404 query is always "stale"; don't re-fire it on every window refocus (more /keypair/me
    // noise) — the create/reset mutations invalidate it explicitly when the keypair actually changes.
    refetchOnWindowFocus: false,
    // CRITICAL (fix #442): do NOT re-fetch a settled-404 query when a new observer mounts. TanStack v5's
    // default `retryOnMount: true` causes `shouldLoadOnMount` to return true whenever
    // `data === undefined && !(status === 'error' && retryOnMount === false)`, so every fresh
    // <UnlockGate> / <CreateVaultDialog> mount re-issues GET /keypair/me → resets status → pending →
    // isMissing false → tree swap → unmount → 404 → isMissing true → remount → … (self-sustaining loop).
    // With retryOnMount: false a settled-error query stays error on remount; isMissing remains stable;
    // the tree does not toggle and the loop cannot form. A cold load is unaffected (initial status is
    // 'pending', not 'error', so the very first fetch still fires). The create/reset mutations call
    // invalidateQueries(keypairKeys.all), an explicit refetch path independent of retryOnMount.
    retryOnMount: false,
  });
}

/**
 * Fetch another user's public key — the wrap target when granting them a vault. `enabled` guards the
 * empty case so the lookup only runs once a target user is chosen.
 */
export function useUserPublicKey(userId: string | undefined) {
  return useQuery({
    queryKey: keypairKeys.publicKey(userId ?? ""),
    queryFn: () => getUserPublicKey(userId as string),
    enabled: Boolean(userId),
  });
}

/**
 * Create the caller's keypair. `data` is the {@link CreateUserKeypair} wire DTO — only public + wrapped
 * material. On success we invalidate the keypair root so `me` re-reads; the DTO is never re-cached as a
 * payload (it has no secret to leak, but we keep the discipline).
 */
export function useCreateKeypair() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserKeypair) => createKeypair(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keypairKeys.all }),
  });
}

/**
 * Reset / replace the caller's keypair (peer-reset / passphrase change). Same wire DTO as create.
 * Invalidates the keypair root so `me` re-reads the new public key.
 */
export function useResetKeypair() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserKeypair) => resetMyKeypair(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keypairKeys.all }),
  });
}
