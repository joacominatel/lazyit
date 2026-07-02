import { sniffAttachment } from './magic-bytes';

/** Build a head buffer from a byte array + optional trailing string. */
function head(bytes: number[], tail = ''): Buffer {
  return Buffer.concat([Buffer.from(bytes), Buffer.from(tail, 'latin1')]);
}

/** A minimal ZIP local-file header whose first entry is `name` (the OOXML sniff shape). */
function zipHead(name: string): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, Buffer.from(name, 'latin1')]);
}

describe('sniffAttachment (ADR-0082 §3 — content decides, never the client label)', () => {
  it('accepts a real PDF named .pdf', () => {
    const result = sniffAttachment(
      head([0x25, 0x50, 0x44, 0x46, 0x2d], '1.7'),
      'warranty.pdf',
    );
    expect(result).toEqual({ ok: true, mimeType: 'application/pdf' });
  });

  it('rejects a fake .pdf that is really HTML (the spoof this guard exists for)', () => {
    const result = sniffAttachment(
      Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>'),
      'invoice.pdf',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/HTML\/SVG/);
  });

  it('rejects SVG outright (red line), whatever the extension claims', () => {
    for (const name of ['diagram.svg', 'diagram.txt', 'diagram.png']) {
      const result = sniffAttachment(Buffer.from('<svg xmlns="…">'), name);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a PNG mislabeled as .pdf (content/extension disagreement)', () => {
    const png = head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffAttachment(png, 'photo.pdf').ok).toBe(false);
    expect(sniffAttachment(png, 'photo.png')).toEqual({
      ok: true,
      mimeType: 'image/png',
    });
  });

  it('accepts jpg under both .jpg and .jpeg', () => {
    const jpg = head([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffAttachment(jpg, 'a.jpg')).toEqual({
      ok: true,
      mimeType: 'image/jpeg',
    });
    expect(sniffAttachment(jpg, 'a.jpeg')).toEqual({
      ok: true,
      mimeType: 'image/jpeg',
    });
  });

  it('accepts gif (87a + 89a) and webp', () => {
    expect(
      sniffAttachment(head([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'x.gif'),
    ).toEqual({
      ok: true,
      mimeType: 'image/gif',
    });
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
    ]);
    expect(sniffAttachment(webp, 'x.webp')).toEqual({
      ok: true,
      mimeType: 'image/webp',
    });
  });

  it('accepts OOXML zips as docx/xlsx by extension, rejects a plain .zip', () => {
    const ooxml = zipHead('[Content_Types].xml');
    expect(sniffAttachment(ooxml, 'report.docx')).toEqual({
      ok: true,
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(sniffAttachment(ooxml, 'sheet.xlsx')).toEqual({
      ok: true,
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // An OOXML payload smuggled under .zip (or anything else) is refused.
    expect(sniffAttachment(ooxml, 'report.zip').ok).toBe(false);
    // A non-OOXML zip is not on the allowlist at all.
    expect(sniffAttachment(zipHead('evil.exe'), 'archive.zip').ok).toBe(false);
    expect(sniffAttachment(zipHead('evil.exe'), 'archive.docx').ok).toBe(false);
  });

  it('accepts plain text and csv by extension when the content is markup-free text', () => {
    expect(sniffAttachment(Buffer.from('hello world'), 'notes.txt')).toEqual({
      ok: true,
      mimeType: 'text/plain',
    });
    expect(sniffAttachment(Buffer.from('a,b,c\n1,2,3'), 'data.csv')).toEqual({
      ok: true,
      mimeType: 'text/csv',
    });
  });

  it('rejects markup-looking text even under .txt/.csv (no stored HTML, red line)', () => {
    expect(
      sniffAttachment(Buffer.from('  <html><body>x'), 'notes.txt').ok,
    ).toBe(false);
    expect(
      sniffAttachment(Buffer.from('<?xml version="1.0"?><svg/>'), 'x.csv').ok,
    ).toBe(false);
  });

  it('rejects unknown binaries (NUL bytes, no known signature)', () => {
    expect(sniffAttachment(head([0x4d, 0x5a, 0x00, 0x01]), 'tool.txt').ok).toBe(
      false,
    );
  });

  it('rejects text under an unknown extension', () => {
    expect(
      sniffAttachment(Buffer.from('#!/bin/sh\nrm -rf /'), 'run.sh').ok,
    ).toBe(false);
  });
});
