import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  extensionOf,
  maxImportBytes,
  maxImportMb,
  parseImportFile,
  sanitizeMarkdown,
  titleFromFilename,
} from './article-import';

const fixture = (name: string): Buffer =>
  readFileSync(join(__dirname, '../../test/fixtures', name));

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

  describe('sanitizeMarkdown', () => {
    it('strips script/style blocks, inline handlers and javascript: URIs', () => {
      const dirty =
        '# Title\n<script>alert(1)</script>\n<div onclick="x()">hi</div>\n[x](javascript:alert(1))';
      const clean = sanitizeMarkdown(dirty);
      expect(clean).not.toMatch(/<script/i);
      expect(clean).not.toMatch(/onclick=/i);
      expect(clean).not.toMatch(/javascript:/i);
      expect(clean).toContain('# Title');
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
