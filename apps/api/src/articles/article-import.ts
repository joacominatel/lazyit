import { BadRequestException } from '@nestjs/common';
import mammoth from 'mammoth';

/**
 * Helpers for the article import endpoint (POST /articles/import): supported-format detection,
 * filename→title, light sanitization, and extraction to markdown. Single-file imports are .md, .txt
 * and .docx; a `.zip` bulk-imports many of those (ADR-0059 §5). .pdf/.html/.odt are deferred (see
 * docs/03-decisions/0021-knowledge-base-design.md).
 */

/** Single-file import extensions (each yields exactly one Article). */
export const SUPPORTED_EXTENSIONS = ['md', 'txt', 'docx'] as const;
/**
 * The bulk-archive extension (ADR-0059 §5). A `.zip` is the SAME ZIP threat class as a `.docx` (both
 * are ZIP containers) — it rides the same sandboxed worker + bomb guard — but FANS OUT to many
 * articles. Kept apart from {@link SUPPORTED_EXTENSIONS} because the worker paths diverge (one parse
 * vs selective extraction + folder mirroring).
 */
export const ZIP_EXTENSION = 'zip' as const;
/** Every extension `POST /articles/import` accepts: the single-file set plus the `.zip` archive. */
export const ALL_IMPORT_EXTENSIONS = [
  ...SUPPORTED_EXTENSIONS,
  ZIP_EXTENSION,
] as const;
const DEFAULT_MAX_IMPORT_MB = 5;

/** True when the upload is a `.zip` bulk archive (vs a single `.md`/`.txt`/`.docx`). */
export function isZipImport(filename: string): boolean {
  return extensionOf(filename) === ZIP_EXTENSION;
}

/**
 * mammoth@1.x still ships a markdown writer and exposes `convertToMarkdown` at runtime, but it is
 * deprecated and absent from the published types — so we declare its shape locally. If a future
 * mammoth removes it, switch to `convertToHtml` + an HTML→markdown step (turndown). See ADR-0021.
 */
type MammothMarkdown = {
  convertToMarkdown(input: { buffer: Buffer }): Promise<{ value: string }>;
};
const mammothMd = mammoth as unknown as MammothMarkdown;

/** Max import size in MB, from MAX_IMPORT_SIZE_MB (default 5); falls back on a missing/bad value. */
export function maxImportMb(): number {
  const raw = process.env.MAX_IMPORT_SIZE_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IMPORT_MB;
}

/** Max import size in bytes. */
export function maxImportBytes(): number {
  return Math.floor(maxImportMb() * 1024 * 1024);
}

/** Lowercased file extension without the dot ("" if none). */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Derive a human title from a filename: drop path + extension, turn -/_ into spaces. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const title = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (title || 'Untitled').slice(0, 200);
}

// Imported content is stored raw, exactly like POST/PATCH /articles (create/update never stripped
// it either). A regex "sanitizer" used to run here on import only — it was bypassable and asymmetric
// (import-only), giving false confidence (SEC-003). It has been removed: the authoritative defense is
// render-time sanitization on the web app (deferred; no KB renderer exists yet — content is shown as
// escaped text). See docs/03-decisions/0029-untrusted-content-sanitization.md.

/**
 * Extract markdown from an uploaded file, dispatching by extension. Throws 400 on an unsupported
 * type or a parse error.
 */
export async function parseImportFile(file: {
  originalname: string;
  buffer: Buffer;
}): Promise<string> {
  const ext = extensionOf(file.originalname);
  switch (ext) {
    case 'md':
    case 'txt':
      return file.buffer.toString('utf-8');
    case 'docx': {
      let value: string;
      try {
        ({ value } = await mammothMd.convertToMarkdown({
          buffer: file.buffer,
        }));
      } catch {
        throw new BadRequestException('Could not parse the .docx file');
      }
      return value;
    }
    default:
      throw new BadRequestException(
        `Unsupported file type "${ext ? '.' + ext : '(none)'}". Supported: ${SUPPORTED_EXTENSIONS.map(
          (e) => '.' + e,
        ).join(', ')}. (.pdf/.html/.odt deferred.)`,
      );
  }
}
