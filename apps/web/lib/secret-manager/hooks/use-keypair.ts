import type { CreateUserKeypair } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createKeypair,
  getMyKeypair,
  getUserPublicKey,
  resetMyKeypair,
} from "../endpoints/keypair";
import { keypairKeys } from "../query-keys";
import { skip4xxRetry } from "./retry";

/**
 * Read + write hooks for the per-user `UserKeypair` (ADR-0061 §3). The wire DTO posted by the create /
 * reset mutations is produced CLIENT-SIDE (`bootstrapKeypair`) — base64 blobs + metadata only. NOTHING
 * secret (passphrase, recovery key, private key) is passed to these hooks, cached, or logged: the
 * caller derives the DTO in the browser and shows the recovery key ONCE before calling create.
 */

/**
 * Retry predicate for `useMyKeypair`: settle immediately on any 4xx (superset of the former 404-only
 * guard); allow up to 3 retries for genuine transient failures (5xx / network). Using the shared
 * `skip4xxRetry` predicate — the original 404-only inline was a subset; the broader 4xx-skip is safe
 * here because any other 4xx (e.g. 401, 403) is equally terminal for this hook. Hoisted to module
 * level so the reference is stable and does not trigger `observerOptionsUpdated` on every mount.
 *
 * @deprecated Use `skip4xxRetry` directly; this alias is kept for readability at the call site.
 */
const keypairRetry = skip4xxRetry;

/** Fetch the caller's own keypair (public key + both wrapped private-key copies). */
export function useMyKeypair() {
  return useQuery({
    queryKey: keypairKeys.me(),
    queryFn: getMyKeypair,
    // A 404 means "this user has never bootstrapped a keypair" — the EXPECTED first-run state, NOT a
    // transient failure. The default `retry: 3` would keep the query `pending` through several backed-off
    // retries (hanging the bootstrap/unlock UI on a spinner and spamming GET /keypair/me), so the page
    // never flips to the bootstrap surface. Settle to error IMMEDIATELY on any 4xx so `isMissing` is true
    // at once and the bootstrap form renders; keep the default retries for genuine transient errors
    // (5xx/network). Now uses the shared skip4xxRetry predicate (fix #444) — wider than the former
    // 404-only guard but equally correct.
    retry: keypairRetry,
    // An errored 4xx query is always "stale"; don't re-fire it on every window refocus (more /keypair/me
    // noise) — the create/reset mutations invalidate it explicitly when the keypair actually changes.
    refetchOnWindowFocus: false,
    // CRITICAL (fix #442): do NOT re-fetch a settled-error query when a new observer mounts. TanStack v5's
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
 *
 * A 404 (target has no keypair — they've never bootstrapped) is a TERMINAL state: we cannot wrap a DEK
 * for them. `retry` skips 4xx immediately; `retryOnMount: false` + `refetchOnWindowFocus: false` prevent
 * the settled-error from re-firing on remount or refocus (mirrors the keypair + chip fix, #442/#444).
 */
export function useUserPublicKey(userId: string | undefined) {
  return useQuery({
    queryKey: keypairKeys.publicKey(userId ?? ""),
    queryFn: () => getUserPublicKey(userId as string),
    enabled: Boolean(userId),
    retry: skip4xxRetry,
    retryOnMount: false,
    refetchOnWindowFocus: false,
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
