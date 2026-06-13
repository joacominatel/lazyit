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
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 3,
    // An errored 404 query is always "stale"; don't re-fire it on every window refocus (more /keypair/me
    // noise) — the create/reset mutations invalidate it explicitly when the keypair actually changes.
    refetchOnWindowFocus: false,
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
