import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { attachmentsDir } from './attachments.constants';

/**
 * Filesystem helpers for the content-addressed blob store (ADR-0082 §2/§3). Pure node:fs — shared
 * by the service, the sandboxed re-encode child and the GC sweep, so it must NOT import any Nest /
 * Express machinery. Layout on the `attachments_data` volume:
 *
 *   <root>/<sha[0:2]>/<sha256>   the blob (sharded — ≤256 top-level dirs, no 10k-entry directory)
 *   <root>/tmp/<random>          in-flight uploads / re-encodes; same volume → finalize = rename()
 *
 * Blobs are keyed by sha256 ONLY — never the client filename (red line: `originalName` is metadata).
 */

/** The in-flight upload directory (same volume as the blobs, so promotion is an atomic rename). */
export function attachmentsTmpDir(root: string = attachmentsDir()): string {
  return join(root, 'tmp');
}

/** The final content-addressed path of a blob: `<root>/<sha[0:2]>/<sha256>`. */
export function blobPathFor(
  sha256: string,
  root: string = attachmentsDir(),
): string {
  return join(root, sha256.slice(0, 2), sha256);
}

/** sha256 (lowercase hex) of a file, computed on the stream — never buffers the whole file. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** The first `bytes` of a file (for the magic-byte sniff) — reads only the head, never the file. */
export async function readFileHead(
  path: string,
  bytes = 4100,
): Promise<Buffer> {
  const fd = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/**
 * Promote a finished tmp file to its content-addressed blob path (ADR-0082 §3 write ordering):
 * fsync the bytes, mkdir the shard, then ONE atomic `rename()` — the caller inserts the DB row only
 * after this resolves (blob-first: a crash in between leaves an unreferenced blob for the GC, never
 * a row pointing at a missing file). DEDUP: when a blob with this sha already exists the tmp copy is
 * simply discarded (identical content — the existing blob is the same bytes by construction).
 */
export async function promoteBlob(
  tmpPath: string,
  sha256: string,
  root: string = attachmentsDir(),
): Promise<void> {
  const dest = blobPathFor(sha256, root);
  const fd = await open(tmpPath, 'r+');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  await mkdir(dirname(dest), { recursive: true });
  try {
    await stat(dest);
    // Dedup: the blob already exists — drop the identical tmp copy.
    await rm(tmpPath, { force: true });
  } catch {
    // Not there yet — atomic promote. A same-sha race would overwrite with identical bytes: benign.
    await rename(tmpPath, dest);
  }
}

/**
 * Best-effort removal of an in-flight tmp file — idempotent (ENOENT is fine: a successful promote
 * already renamed it away). Called in `finally` on EVERY upload path so a rejected upload (authz,
 * sniff, cap, budget) never leaks bytes into tmp/.
 */
export async function discardTmp(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}
