import type {
  DirectoryConnection,
  DirectorySyncResult,
  UpdateDirectoryConnection,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the on-prem AD/LDAP directory source (issue #839, ADR-0091) — the ONLY
 * place that talks to `apiFetch` for the directory connection. Hooks (../hooks/use-directory-connection.ts)
 * wrap these in TanStack Query; the Settings → Instance → Directory editor consumes the hooks, never these
 * directly (ADR-0020).
 *
 * Routes mirror apps/api/src/directory (all gated `settings:manage` + forbidden to service principals). The
 * GET never 404s for "unset" — the API returns an explicit disabled default (`enabled: false`) so the form
 * always has a concrete shape to render (the SmtpSettings/AssetTagScheme convention). The bind password is
 * WRITE-ONLY: the read shape exposes only `bindPasswordSet`, never the value; the PUT keeps the stored
 * password when `bindPassword` is omitted/empty.
 */
const BASE = "/directory";

/**
 * Read the current directory connection (`GET /directory/connection`). Returns the persisted (redacted) row
 * or — when nothing was ever configured — an explicit disabled default. `settings:manage` (403 otherwise);
 * the bind password is never returned, only `bindPasswordSet`. Also carries the cached last-run outcome
 * (`lastSyncAt` / `lastSyncStatus` / `lastSyncCounts`) the result panel renders.
 */
export function getDirectoryConnection(
  signal?: AbortSignal,
): Promise<DirectoryConnection> {
  return apiFetch<DirectoryConnection>(`${BASE}/connection`, { signal });
}

/**
 * Upsert the directory connection (`PUT /directory/connection`, `settings:manage`). The bind password is
 * write-only: OMIT it (or send empty) to keep the stored password, send a non-empty value to set/rotate it.
 * Returns the persisted (redacted) config. 409 if a bind password is supplied while the server key
 * `DIRECTORY_SECRET_KEY` is unset (its message explains the operator must set the key); 400 on a body the
 * shared schema rejects (e.g. a malformed baseDN/bindDN/searchFilter).
 */
export function updateDirectoryConnection(
  body: UpdateDirectoryConnection,
): Promise<DirectoryConnection> {
  return apiFetch<DirectoryConnection>(`${BASE}/connection`, {
    method: "PUT",
    body,
  });
}

/**
 * Run the directory sync now (`POST /directory/sync`, `settings:manage`) — the SAME read-only reconcile the
 * scheduled sweeper runs (bind, subtree-search, upsert login-less directory persons). Doubles as the
 * connectivity/bind check: always HTTP 200 — inspect `ok`; on a bind/search failure `ok:false` + a short,
 * non-secret `error` the editor surfaces (never the bind password, DNs, or PII).
 */
export function syncDirectoryNow(): Promise<DirectorySyncResult> {
  return apiFetch<DirectorySyncResult>(`${BASE}/sync`, { method: "POST" });
}
