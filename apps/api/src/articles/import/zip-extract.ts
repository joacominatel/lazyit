import JSZip from 'jszip';

/**
 * Selective `.zip` extraction for the bulk article import (ADR-0059 §5), run INSIDE the BullMQ
 * sandboxed child (SEC-002). A `.zip` is the SAME ZIP threat class as the `.docx` the worker already
 * defends: a decompression bomb is a tiny, limit-compliant archive whose entries expand to gigabytes.
 * The forked child's heap cap (`IMPORT_CHILD_HEAP_MB`) is the last line; this module adds the
 * QUOTA layer in front of it — an entry-count cap and a total-uncompressed-size cap checked from the
 * archive's central directory BEFORE any entry is decompressed into the heap.
 *
 * Selective: only `.md`/`.txt` text entries (and their folder paths) are extracted; everything else —
 * images, binaries, a nested `.docx` (deferred to a follow-up), dotfiles, directory entries — is
 * reported as `skipped`, never an error. Pure and Prisma-free, so it is unit-testable without Redis
 * or a DB.
 */

/**
 * Hard upper bound on the number of entries we will even ENUMERATE from the archive. A small IT
 * team's KB migration is dozens-to-a-few-hundred notes; 500 is generous while bounding the fan-out
 * (each accepted entry mints an Article + a version-1 snapshot + wiki-link edges in one job). A zip
 * bomb that packs millions of zero-byte entries is rejected here, before the per-entry walk, on the
 * central-directory count alone — cheap, no decompression. Counts ALL entries (skipped included), so
 * a haystack of junk around a few notes can't slip a huge enumeration past the cap.
 */
export const MAX_ZIP_ENTRIES = 500;

/**
 * Hard upper bound on the TOTAL uncompressed size we will decompress from the archive, across every
 * accepted text entry. 50 MB is roomy for text (a 50 MB markdown vault is enormous for a 5–20-person
 * team) while blocking a classic high-ratio bomb: a few-hundred-KB archive (it sails through the
 * MAX_IMPORT_SIZE_MB upload cap, SEC-001) that would expand to gigabytes. The size is read from each
 * entry's metadata and accumulated; the running total is checked BEFORE decompressing the next entry,
 * so the heap never holds more than ~one entry past the cap.
 */
export const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

/** Text extensions we extract; everything else is skipped (ADR-0059 §5). */
const TEXT_EXTENSIONS = new Set(['md', 'txt']);

/** A short, human-readable reason an entry was skipped (never an error — §5). */
export type SkipReason =
  | 'directory'
  | 'dotfile'
  | 'unsupported-type'
  | 'empty';

/** An accepted text entry: its archive path, the folder segments above it, and its decoded body. */
export interface ZipTextEntry {
  /** The full path inside the archive, normalized (forward slashes, no leading `./` or `/`). */
  path: string;
  /** The folder segments above the file (e.g. `["Servers", "Linux"]`); empty = a root-level file. */
  folderSegments: string[];
  /** The file's basename including extension (e.g. `provisioning.md`). */
  fileName: string;
  /** The decoded UTF-8 text body. */
  content: string;
}

/** An entry that was ignored — surfaced as a `skipped` item in the batch result, never an error. */
export interface ZipSkippedEntry {
  path: string;
  reason: SkipReason;
}

/** The result of a selective extraction: the accepted text entries plus every skipped entry. */
export interface ZipExtractResult {
  entries: ZipTextEntry[];
  skipped: ZipSkippedEntry[];
}

/** Options for {@link extractZipEntries} — overridable in tests; production uses the module caps. */
export interface ZipExtractOptions {
  maxEntries?: number;
  maxUncompressedBytes?: number;
}

/**
 * Thrown when the archive breaches a quota (entry count or total uncompressed size) — the QUOTA arm
 * of the SEC-002 bomb guard. Distinct from a generic parse error so the service can map it to a
 * clear, permanent "too large/too many" message (never "try again"). A real high-ratio bomb that
 * slips the metadata check still dies on the child's heap cap.
 */
export class ZipQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipQuotaExceededError';
  }
}

/** Lowercased extension without the dot ("" if none), from a basename. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Normalize an archive entry path: convert backslashes to forward slashes, strip a leading `./` or
 * `/`, and collapse `..` traversal segments (a `.zip` can carry `../` paths — Zip Slip; we never
 * write to disk, but a normalized path keeps the mirrored folder tree honest). Returns the cleaned
 * path; an entirely-empty result is left as "".
 */
function normalizePath(raw: string): string {
  const slashed = raw.replace(/\\/g, '/');
  const parts = slashed.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Drop a traversal rather than escape the archive root (defensive — we never write to disk).
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Selectively extract the text entries from a `.zip` buffer with the SEC-002 bomb-guard quota
 * (ADR-0059 §5). Steps:
 *  1. Load the archive's central directory (no entry is decompressed yet).
 *  2. QUOTA: reject if the entry count exceeds `maxEntries`, before any per-entry work.
 *  3. Walk entries in path order: classify each (directory / dotfile / unsupported / text). For a
 *     text entry, account its declared uncompressed size against the running total and reject if it
 *     would exceed `maxUncompressedBytes` — BEFORE decompressing it (so the heap never holds more
 *     than ~one entry past the cap). Then decompress and decode it.
 *  4. An empty/whitespace-only text body is `skipped` (no text content), never created.
 *
 * Throws {@link ZipQuotaExceededError} on a quota breach and a plain Error on a corrupt/non-zip
 * buffer. A high-ratio bomb whose declared sizes lie still dies on the child's heap cap.
 */
export async function extractZipEntries(
  buffer: Buffer,
  opts: ZipExtractOptions = {},
): Promise<ZipExtractResult> {
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxBytes = opts.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;

  let zip: JSZip;
  try {
    // Load the central directory only — JSZip defers per-entry decompression until `async(...)`.
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('Could not read the .zip archive (corrupt or not a zip file)');
  }

  // All entries, including directory markers. `files` is the central directory — cheap to enumerate.
  const allEntries = Object.values(zip.files);

  // QUOTA #1 — entry count. Rejected on the central-directory count alone (no decompression), so a
  // bomb of millions of zero-byte entries dies here, cheaply.
  if (allEntries.length > maxEntries) {
    throw new ZipQuotaExceededError(
      `The archive has ${allEntries.length} entries, over the ${maxEntries}-entry import limit`,
    );
  }

  const entries: ZipTextEntry[] = [];
  const skipped: ZipSkippedEntry[] = [];
  let totalUncompressed = 0;

  // Deterministic order: by normalized path, so folder creation and the per-item report are stable.
  const sorted = [...allEntries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of sorted) {
    const path = normalizePath(entry.name);
    // A directory marker (or a path that normalized to nothing) — structure only, no file.
    if (entry.dir || path === '') {
      skipped.push({ path: entry.name, reason: 'directory' });
      continue;
    }
    const segments = path.split('/');
    const fileName = segments[segments.length - 1];
    const folderSegments = segments.slice(0, -1);

    // Dotfiles and anything under a dot-folder (`.git/`, `.obsidian/`, `__MACOSX/.DS_Store`, …) are
    // noise from an exported vault — skipped, never an error.
    if (fileName.startsWith('.') || folderSegments.some((s) => s.startsWith('.'))) {
      skipped.push({ path, reason: 'dotfile' });
      continue;
    }

    const ext = extOf(fileName);
    if (!TEXT_EXTENSIONS.has(ext)) {
      // Images, binaries, a nested `.docx` (deferred — §5), anything non-text: skipped.
      skipped.push({ path, reason: 'unsupported-type' });
      continue;
    }

    // QUOTA #2 — total uncompressed size. `_data.uncompressedSize` is the declared size from the
    // entry header; account it BEFORE decompressing so the heap never holds more than ~one entry
    // past the cap. (A lying header that under-declares is still caught by the child's heap cap.)
    const declared =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (totalUncompressed + declared > maxBytes) {
      throw new ZipQuotaExceededError(
        `The archive's text entries exceed the ${Math.floor(maxBytes / (1024 * 1024))} MB uncompressed import limit`,
      );
    }

    // Decompress + decode this one entry. In the sandboxed child a bomb that slipped the declared
    // size still OOMs here, under the heap cap (SEC-002).
    const content = await entry.async('string');
    // Account the ACTUAL decoded length too, in case the declared size under-reported, and re-check.
    totalUncompressed += Math.max(declared, Buffer.byteLength(content, 'utf-8'));
    if (totalUncompressed > maxBytes) {
      throw new ZipQuotaExceededError(
        `The archive's text entries exceed the ${Math.floor(maxBytes / (1024 * 1024))} MB uncompressed import limit`,
      );
    }

    if (!content.trim()) {
      // A real but empty note: skipped (no text content), never created — and never an error.
      skipped.push({ path, reason: 'empty' });
      continue;
    }

    entries.push({ path, folderSegments, fileName, content });
  }

  return { entries, skipped };
}
