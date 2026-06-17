import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ImportEntity,
  ImportMapping,
  ImportResolutionPlan,
} from "@lazyit/shared";
import {
  commitImport,
  getImportResult,
  getImportSession,
  runImportDryRun,
  saveImportPlan,
  setImportMapping,
  startImport,
} from "../endpoints/imports";

/**
 * TanStack Query hooks for the guided bulk Migrator wizard (ADR-0069, #637) over the owner-scoped
 * `/imports/*` surface. The wizard step components consume these; the data-access functions
 * (../endpoints/imports.ts) are never called directly (ADR-0020).
 *
 * Two endpoints are ASYNC and polled: the upload (poll the SESSION until PARSED/FAILED) and the
 * commit (poll the RESULT until counts land). Both use a short `refetchInterval` that stops once a
 * terminal state is reached — the same async-accept-then-poll shape as the KB article import. The
 * map / dry-run / plan steps are synchronous mutations the wizard awaits in order.
 */

/** Session-view query keys (scoped per session id — a wizard works on one session at a time). */
export const importKeys = {
  all: ["imports"] as const,
  session: (id: string) => ["imports", "session", id] as const,
  result: (id: string) => ["imports", "result", id] as const,
};

/** Poll cadence for the async parse + commit phases (matches the article-import poll). */
const POLL_INTERVAL_MS = 1500;

/** Session statuses that are still settling (the parse hasn't finished / the commit is running). */
const TRANSIENT_SESSION_STATUSES = new Set(["PENDING", "PARSING", "COMMITTING"]);

/**
 * Poll a session view (`GET /imports/:id`). Idle until a `sessionId` exists. Polls every ~1.5s while
 * the status is transient (PENDING/PARSING/COMMITTING) and stops once it settles (PARSED/MAPPED/
 * DRY_RUN/COMMITTED/FAILED/EXPIRED) — so the parse and the commit progress both ride this one poll.
 * Fails surfaced via the query error (404 → unknown/expired session) the wizard maps to a message.
 */
export function useImportSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: importKeys.session(sessionId ?? ""),
    queryFn: ({ signal }) => getImportSession(sessionId as string, signal),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TRANSIENT_SESSION_STATUSES.has(status)
        ? POLL_INTERVAL_MS
        : false;
    },
  });
}

/**
 * Poll the commit result (`GET /imports/:id/result`). Only enabled once the wizard reaches the commit
 * step (`enabled`). Polls until the ledger `counts` land (null while the chunked commit is still
 * running), then stops. The session poll above is the source of truth for the COMMITTED/FAILED
 * transition; this carries the final counts the result screen renders.
 */
export function useImportResult(
  sessionId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: importKeys.result(sessionId ?? ""),
    queryFn: ({ signal }) => getImportResult(sessionId as string, signal),
    enabled: Boolean(sessionId) && enabled,
    refetchInterval: (query) =>
      query.state.data?.counts == null ? POLL_INTERVAL_MS : false,
  });
}

/** Upload a file → 202 `{ sessionId }` (`POST /imports`). The caller starts the session poll on success. */
export function useStartImport() {
  return useMutation({
    mutationFn: ({ file, entity }: { file: File; entity?: ImportEntity }) =>
      startImport(file, entity),
  });
}

/** Confirm the mapping (`POST /imports/:id/mapping`) → MAPPED. Returns the refreshed session view. */
export function useSetImportMapping() {
  return useMutation({
    mutationFn: ({ id, mapping }: { id: string; mapping: ImportMapping }) =>
      setImportMapping(id, mapping),
  });
}

/** Run the dry-run (`POST /imports/:id/dry-run`) — writes nothing; returns the report to resolve. */
export function useRunImportDryRun() {
  return useMutation({
    mutationFn: (id: string) => runImportDryRun(id),
  });
}

/** Freeze the resolution plan (`POST /imports/:id/plan`) → DRY_RUN. Returns the refreshed session. */
export function useSaveImportPlan() {
  return useMutation({
    mutationFn: ({ id, plan }: { id: string; plan: ImportResolutionPlan }) =>
      saveImportPlan(id, plan),
  });
}

/** Enqueue the commit (`POST /imports/:id/commit`, 202). The caller starts the result poll on success. */
export function useCommitImport() {
  return useMutation({
    mutationFn: (id: string) => commitImport(id),
  });
}
