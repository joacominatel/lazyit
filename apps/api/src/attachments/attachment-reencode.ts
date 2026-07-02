import sharp from 'sharp';

/**
 * The security-critical raster RE-ENCODE, defined ONCE (ADR-0082 §3). Rewriting an image's pixels
 * strips EXIF/GPS metadata (sharp drops metadata unless asked to keep it) and neutralizes polyglot
 * files (a JPEG that is also a script becomes pixels-only after re-encode). Two callers share it so
 * the decode/re-encode behaviour never drifts between them:
 *  - the sandboxed `attachment-reencode` processor (upload path — re-encodes a promoted blob by path);
 *  - the sandboxed KB-import ingest (import path — re-encodes a decoded data-URI Buffer, ADR-0082 §5).
 *
 * Both run in a forked, heap-capped BullMQ child (SEC-002 / ADR-0053): image decoding allocates
 * native memory proportional to attacker-supplied dimensions, so a decompression bomb kills the CHILD,
 * never the API. sharp's own `limitInputPixels` default is the first line of that defence.
 */

// Bound sharp's native memory wherever this module is loaded (both sandboxed children): no libvips
// operation cache, one worker thread. Set at import time so every caller inherits the same limits.
sharp.cache(false);
sharp.concurrency(1);

/** The raster image types we re-encode, each to ITS OWN format (the stored mimeType never changes). */
export const RASTER_FORMATS: Record<string, keyof sharp.FormatEnum> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Build the sharp pipeline that re-encodes a raster image to its own format. `input` is a file path
 * (the upload processor) or a decoded Buffer (the import ingest); `mimeType` MUST be a key of
 * {@link RASTER_FORMATS} — the caller checks the allowlist first. The pipeline is not executed here:
 * the caller runs `.toFile(...)` or `.toBuffer()`.
 */
export function reencodeRaster(
  input: Buffer | string,
  mimeType: string,
): sharp.Sharp {
  const format = RASTER_FORMATS[mimeType];
  return sharp(input, {
    // Keep every gif/webp frame; sharp strips EXIF/ICC-extras by default (no `.keepMetadata()`),
    // which is exactly the point of the re-encode.
    animated: mimeType === 'image/gif' || mimeType === 'image/webp',
  }).toFormat(format);
}
