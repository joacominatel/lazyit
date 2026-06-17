/**
 * Wiring constants for the migrator COMMIT queue (ADR-0069 wave 4a, #633).
 *
 * Unlike the PARSE queue — a SANDBOXED forked child (untrusted-file bomb isolation, SEC-002) — the
 * commit replays ALREADY-PARSED rows from the DB and MUST route every write through the Nest-DI
 * `AssetsService.create()` (history + actor + asset-tag invariants). So the commit worker is an
 * IN-PROCESS `@Processor`/`WorkerHost` (full DI), mirroring the workflow-run worker — NOT a forked
 * child. There is no file-bomb surface at commit time (the bytes were discarded after parse, §2).
 */

/** The BullMQ queue name for migrator commit jobs (in-process worker). */
export const IMPORT_COMMIT_QUEUE = 'import-commit';

/** The job name added to the commit queue. */
export const IMPORT_COMMIT_JOB_NAME = 'commit-import';

/**
 * Rows committed per progress checkpoint (ADR-0069 §10: chunked 100–200 rows). The commit is per-row
 * transactional regardless (one asset + its CREATED history = the unit of atomicity), so a "chunk" here
 * is only the cadence at which we flush `job.updateProgress` and re-check resumability — it does NOT
 * widen the transaction boundary. Pure data, no behavioral coupling.
 */
export const COMMIT_CHUNK_SIZE = 100;
