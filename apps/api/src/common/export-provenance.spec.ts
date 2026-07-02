import {
  appVersion,
  checkImportProvenance,
  provenanceStampLine,
} from './export-provenance';

// Version provenance for exports/imports (issue #909, ADR-0083). The headline behaviour: a stamp from
// a NEWER major than the running server is refused with a clear message; a MISSING stamp (legacy /
// third-party) and same/older majors are accepted.
describe('export-provenance', () => {
  const originalEnv = process.env.APP_VERSION;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = originalEnv;
  });

  describe('appVersion', () => {
    it("reads APP_VERSION, falling back to 'dev'", () => {
      process.env.APP_VERSION = 'v2.1.0';
      expect(appVersion()).toBe('v2.1.0');
      delete process.env.APP_VERSION;
      expect(appVersion()).toBe('dev');
    });
  });

  describe('provenanceStampLine', () => {
    it('formats "# lazyit <version> — <ISO>" from the running build', () => {
      process.env.APP_VERSION = 'v1.4.2';
      const line = provenanceStampLine(new Date('2026-07-02T10:00:00.000Z'));
      expect(line).toBe('# lazyit v1.4.2 — 2026-07-02T10:00:00.000Z');
    });
  });

  describe('checkImportProvenance', () => {
    it('accepts a file with NO stamp unchanged (legacy / hand-made / third-party)', () => {
      const text = 'name,serial\nLaptop,ABC123\n';
      expect(checkImportProvenance(text, 'v1.0.0')).toEqual({
        text,
        incompatibleReason: null,
      });
    });

    it('rejects a stamp from a NEWER major than the server, with a clear message', () => {
      const text =
        '# lazyit v2.0.0 — 2026-07-02T10:00:00.000Z\nname,serial\nLaptop,ABC123\n';
      const result = checkImportProvenance(text, 'v1.4.2');
      expect(result.incompatibleReason).toContain('v2.0.0');
      expect(result.incompatibleReason).toContain('newer major');
      // The stamp line is stripped even when rejected.
      expect(result.text).toBe('name,serial\nLaptop,ABC123\n');
    });

    it('accepts a stamp from the SAME major and strips the stamp line', () => {
      const text =
        '# lazyit v1.9.0 — 2026-07-02T10:00:00.000Z\nname,serial\nLaptop,ABC123\n';
      expect(checkImportProvenance(text, 'v1.4.2')).toEqual({
        text: 'name,serial\nLaptop,ABC123\n',
        incompatibleReason: null,
      });
    });

    it('accepts a stamp from an OLDER major and strips the stamp line', () => {
      const text = '# lazyit v1.0.0 — 2026-01-01T00:00:00.000Z\nname\nLaptop\n';
      expect(checkImportProvenance(text, 'v2.3.1')).toEqual({
        text: 'name\nLaptop\n',
        incompatibleReason: null,
      });
    });

    it('disables the gate on a dev server (accepts any stamped major)', () => {
      const text =
        '# lazyit v99.0.0 — 2026-07-02T10:00:00.000Z\nname\nLaptop\n';
      expect(checkImportProvenance(text, 'dev').incompatibleReason).toBeNull();
    });

    it('handles CRLF line endings when stripping the stamp', () => {
      const text = '# lazyit v1.0.0 — x\r\nname\r\nLaptop\r\n';
      expect(checkImportProvenance(text, 'v1.0.0').text).toBe(
        'name\r\nLaptop\r\n',
      );
    });
  });
});
