/**
 * Magic-byte sniff for the attachment upload (ADR-0082 §3) — the type is decided by CONTENT, never
 * the client extension or Content-Type header (red line: no client-MIME trust). Pure and
 * dependency-free: the allowlist is small and fixed (pdf, png, jpg, webp, gif, txt, csv, docx,
 * xlsx), so a table of signatures beats a new dependency.
 *
 * Contract:
 * - The sniffed type must ALSO agree with the client extension (a `.pdf` that is really a PNG is
 *   rejected — mislabeled content is exactly the spoofing this guard exists for).
 * - SVG and HTML are rejected OUTRIGHT wherever they are detected (stored-XSS vectors — red line),
 *   with an explicit reason so the UI can say why.
 * - docx/xlsx share the ZIP container signature; the container is verified by magic bytes (PK local
 *   header whose FIRST entry is `[Content_Types].xml` — the OOXML marker), then the extension picks
 *   which OOXML type. Safe: both are served as opaque `attachment` downloads with `nosniff` + CSP
 *   sandbox, so the docx/xlsx distinction is labeling, not a security boundary. A plain .zip (no
 *   OOXML marker) is rejected — zip is not on the allowlist.
 */

export type SniffResult =
  | { ok: true; mimeType: string }
  | { ok: false; reason: string };

/** Lowercased extension without the dot ('' if none) — mirrors article-import's extensionOf. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Binary signatures at offset 0 → detected MIME + the extensions that agree with it. */
const BINARY_SIGNATURES: ReadonlyArray<{
  bytes: number[];
  mimeType: string;
  extensions: readonly string[];
}> = [
  {
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d],
    mimeType: 'application/pdf',
    extensions: ['pdf'],
  }, // %PDF-
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mimeType: 'image/png',
    extensions: ['png'],
  },
  {
    bytes: [0xff, 0xd8, 0xff],
    mimeType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
  },
  {
    bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    mimeType: 'image/gif',
    extensions: ['gif'],
  }, // GIF87a
  {
    bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    mimeType: 'image/gif',
    extensions: ['gif'],
  }, // GIF89a
];

function startsWithBytes(head: Buffer, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

/** RIFF....WEBP — the WebP container (bytes 0-3 `RIFF`, 8-11 `WEBP`). */
function isWebp(head: Buffer): boolean {
  return (
    startsWithBytes(head, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(head, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

/**
 * OOXML detection: a ZIP local-file header (`PK\x03\x04`) whose FIRST entry is named
 * `[Content_Types].xml` — how Word/Excel write their packages. The entry name sits at offset 30,
 * its length at offset 26 (LE u16).
 */
function isOoxmlZip(head: Buffer): boolean {
  if (!startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04])) return false;
  if (head.length < 30) return false;
  const nameLength = head.readUInt16LE(26);
  const name = head.subarray(30, 30 + nameLength).toString('latin1');
  return name === '[Content_Types].xml';
}

/**
 * Does this text LOOK like HTML/SVG/XML markup? Checked on every text candidate — the red-line
 * rejection ("no SVG, no HTML"), and the guard that catches a fake `.pdf`/`.txt` that is really a
 * web page. Deliberately aggressive: an attachment store has no reason to hold markup.
 */
function looksLikeMarkup(text: string): boolean {
  // Strip a UTF-8 BOM and leading whitespace before matching.
  const start = text
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return (
    start.startsWith('<!doctype') ||
    start.startsWith('<html') ||
    start.startsWith('<svg') ||
    start.startsWith('<?xml') ||
    start.includes('<script')
  );
}

/**
 * Sniff an upload's true type from its head bytes + verify the client extension agrees. Returns the
 * server-derived MIME to STORE AND SERVE (the client's Content-Type is never consulted). The caller
 * still checks the result against the per-surface allowlist (asset docs vs article images).
 */
export function sniffAttachment(head: Buffer, filename: string): SniffResult {
  const ext = extensionOf(filename);

  // 1. Binary signatures (offset 0).
  for (const sig of BINARY_SIGNATURES) {
    if (startsWithBytes(head, sig.bytes)) {
      if (!sig.extensions.includes(ext)) {
        return {
          ok: false,
          reason: `The file's content is ${sig.mimeType} but its name ends in ".${ext}" — the extension must match the actual content.`,
        };
      }
      return { ok: true, mimeType: sig.mimeType };
    }
  }
  if (isWebp(head)) {
    if (ext !== 'webp') {
      return {
        ok: false,
        reason: `The file's content is image/webp but its name ends in ".${ext}" — the extension must match the actual content.`,
      };
    }
    return { ok: true, mimeType: 'image/webp' };
  }

  // 2. ZIP container → only OOXML (docx/xlsx) is acceptable; the extension picks which.
  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (!isOoxmlZip(head)) {
      return {
        ok: false,
        reason:
          'ZIP archives are not an accepted attachment type (only .docx/.xlsx Office documents).',
      };
    }
    if (ext === 'docx') return { ok: true, mimeType: DOCX_MIME };
    if (ext === 'xlsx') return { ok: true, mimeType: XLSX_MIME };
    return {
      ok: false,
      reason:
        'The file is an Office document but its extension is not .docx or .xlsx.',
    };
  }

  // 3. Text candidates (txt/csv have no magic bytes). A NUL byte in the head = some unknown binary.
  if (head.includes(0)) {
    return {
      ok: false,
      reason: 'Unrecognized file content — this file type is not accepted.',
    };
  }
  const text = head.toString('utf8');
  if (looksLikeMarkup(text)) {
    return {
      ok: false,
      reason:
        'HTML/SVG content is not allowed as an attachment (it can execute in a browser). Export diagrams to PNG.',
    };
  }
  if (ext === 'txt') return { ok: true, mimeType: 'text/plain' };
  if (ext === 'csv') return { ok: true, mimeType: 'text/csv' };
  return {
    ok: false,
    reason: `Unsupported file type "${ext ? '.' + ext : '(none)'}" for this content.`,
  };
}
