import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import multer from 'multer';
import {
  extensionOf,
  importUploadOptions,
  maxImportBytes,
  maxImportMb,
  parseImportFile,
  titleFromFilename,
} from './article-import';

const fixture = (name: string): Buffer =>
  readFileSync(join(__dirname, '../../test/fixtures', name));

/** Push one multipart part through multer exactly as a browser sends it: the filename as raw UTF-8 bytes. */
async function parseUpload(filename: string): Promise<Express.Multer.File> {
  const boundary = 'lazyitboundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
      'utf8',
    ),
    Buffer.from('Content-Type: text/markdown\r\n\r\n# Body\n'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const req = Object.assign(new PassThrough(), {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  });
  const middleware = multer(importUploadOptions()).single('file');
  const done = new Promise<Express.Multer.File>((resolve, reject) =>
    middleware(req as never, {} as never, (err?: unknown) =>
      err
        ? reject(err instanceof Error ? err : new Error('multer failed'))
        : resolve((req as unknown as { file: Express.Multer.File }).file),
    ),
  );
  req.end(body);
  return done;
}

describe('importUploadOptions (AUD-048)', () => {
  it('decodes a non-ASCII filename as UTF-8, so the imported title is not mojibake', async () => {
    const file = await parseUpload('garantía.md');
    expect(file.originalname).toBe('garantía.md');
    expect(titleFromFilename(file.originalname)).toBe('garantía');
    expect(file.buffer.toString()).toBe('# Body\n');
  });
});

describe('article-import helpers', () => {
  describe('extensionOf', () => {
    it('returns the lowercased extension, or "" when there is none', () => {
      expect(extensionOf('Notes.MD')).toBe('md');
      expect(extensionOf('archive.tar.gz')).toBe('gz');
      expect(extensionOf('noext')).toBe('');
    });
  });

  describe('titleFromFilename', () => {
    it('drops the path and extension and turns separators into spaces', () => {
      expect(titleFromFilename('/tmp/network-setup_guide.docx')).toBe(
        'network setup guide',
      );
    });
    it('falls back to "Untitled" when nothing is left', () => {
      expect(titleFromFilename('.md')).toBe('Untitled');
    });
  });

  describe('content is stored verbatim (SEC-003)', () => {
    it('does not strip markup from imported content (sanitization is deferred to render time)', async () => {
      const md = await parseImportFile({
        originalname: 'note.md',
        buffer: Buffer.from('# Title\n<script>alert(1)</script>\nbody'),
      });
      // Import is now consistent with create/update: content is stored raw. The bypassable,
      // import-only regex strip was removed; the authoritative defense is render-time sanitization
      // on the web app (ADR-0029). This asserts the strip is gone (the old code removed <script>).
      expect(md).toContain('<script>alert(1)</script>');
      expect(md).toContain('# Title');
    });
  });

  describe('max import size', () => {
    const original = process.env.MAX_IMPORT_SIZE_MB;
    afterEach(() => {
      if (original === undefined) delete process.env.MAX_IMPORT_SIZE_MB;
      else process.env.MAX_IMPORT_SIZE_MB = original;
    });

    it('defaults to 5 MB when unset or invalid', () => {
      delete process.env.MAX_IMPORT_SIZE_MB;
      expect(maxImportMb()).toBe(5);
      process.env.MAX_IMPORT_SIZE_MB = 'nonsense';
      expect(maxImportMb()).toBe(5);
      expect(maxImportBytes()).toBe(5 * 1024 * 1024);
    });

    it('honors a valid override', () => {
      process.env.MAX_IMPORT_SIZE_MB = '2';
      expect(maxImportMb()).toBe(2);
      expect(maxImportBytes()).toBe(2 * 1024 * 1024);
    });
  });

  describe('parseImportFile', () => {
    it('reads .md content as-is', async () => {
      const md = await parseImportFile({
        originalname: 'a.md',
        buffer: Buffer.from('# Hello\n\nWorld'),
      });
      expect(md).toContain('# Hello');
    });

    it('reads .txt content as plain markdown', async () => {
      const txt = await parseImportFile({
        originalname: 'a.txt',
        buffer: Buffer.from('line one\nline two'),
      });
      expect(txt).toContain('line one');
    });

    it('converts a real .docx to markdown via mammoth', async () => {
      const md = await parseImportFile({
        originalname: 'sample.docx',
        buffer: fixture('sample.docx'),
      });
      expect(md).toContain('Datacenter Runbook');
      expect(md).toContain('core switch');
    });

    it('reads the .md and .txt fixtures', async () => {
      const md = await parseImportFile({
        originalname: 'sample.md',
        buffer: fixture('sample.md'),
      });
      expect(md).toContain('Network Setup');
      const txt = await parseImportFile({
        originalname: 'sample.txt',
        buffer: fixture('sample.txt'),
      });
      expect(txt).toContain('Backup Procedure');
    });

    it('rejects an unsupported file type with 400', async () => {
      await expect(
        parseImportFile({
          originalname: 'doc.pdf',
          buffer: Buffer.from('%PDF'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
