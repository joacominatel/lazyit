import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import multer from 'multer';
import { attachmentsUploadOptions } from './attachment-upload.storage';

/** Push one multipart part through multer exactly as a browser sends it: the filename as raw UTF-8 bytes. */
async function parseUpload(filename: string): Promise<Express.Multer.File> {
  const boundary = 'lazyitboundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
      'utf8',
    ),
    Buffer.from('Content-Type: application/pdf\r\n\r\n%PDF-1.7\n'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const req = Object.assign(new PassThrough(), {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  });
  const middleware = multer(attachmentsUploadOptions(1024 * 1024)).single(
    'file',
  );
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

describe('attachmentsUploadOptions (AUD-048)', () => {
  beforeEach(async () => {
    process.env.ATTACHMENTS_DIR = await mkdtemp(
      join(tmpdir(), 'lazyit-upload-'),
    );
  });

  afterEach(() => {
    delete process.env.ATTACHMENTS_DIR;
  });

  it('decodes a non-ASCII filename as UTF-8, not latin1 mojibake', async () => {
    const file = await parseUpload('garantía — 保証.pdf');
    expect(file.originalname).toBe('garantía — 保証.pdf');
  });

  it('leaves an ASCII filename unchanged', async () => {
    const file = await parseUpload('warranty.pdf');
    expect(file.originalname).toBe('warranty.pdf');
  });
});
