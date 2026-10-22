import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { ExportColumn } from './export-column';
import { streamXlsx } from './stream-xlsx';
import { XLSX_STYLE } from './xlsx-sheet';
import {
  collectBuffer,
  readXlsx,
  xlsxRecords,
} from '../../../test/xlsx-reader';

interface Row {
  name: string;
  qty: number;
  cost: number | bigint | null;
  currency: string | null;
  at: Date | null;
}

const COLUMNS: ExportColumn<Row>[] = [
  { header: 'name', kind: 'text', value: (r) => r.name },
  { header: 'qty', kind: 'number', value: (r) => r.qty },
  { header: 'cost', kind: 'money', value: (r) => r.cost },
  { header: 'currency', kind: 'text', value: (r) => r.currency },
  { header: 'at', kind: 'date', value: (r) => r.at },
];

async function* batchesOf<T>(...batches: T[][]): AsyncGenerator<T[]> {
  for (const batch of batches) yield await Promise.resolve(batch);
}

const ROWS: Row[] = [
  {
    name: 'Laptop',
    qty: 2,
    cost: 150050,
    currency: 'USD',
    at: new Date('2026-10-16T00:00:00.000Z'),
  },
  {
    name: '=HYPERLINK("http://evil","x")',
    qty: -5,
    cost: null,
    currency: null,
    at: new Date('2026-10-16T12:00:00.000Z'),
  },
];

describe('streamXlsx — the package', () => {
  it('is a valid one-sheet SpreadsheetML package', async () => {
    const read = await readXlsx(
      await collectBuffer(
        streamXlsx({
          columns: COLUMNS,
          batches: batchesOf(ROWS),
          sheetName: 'purchases',
        }),
      ),
    );

    expect(Object.keys(read.parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    // Every overridden part exists, and every relationship target resolves.
    for (const [, part] of read.parts['[Content_Types].xml'].matchAll(
      /PartName="\/([^"]+)"/g,
    )) {
      expect(read.parts[part]).toBeDefined();
    }
    for (const [, target] of read.parts['_rels/.rels'].matchAll(
      /Target="([^"]+)"/g,
    )) {
      expect(read.parts[target]).toBeDefined();
    }
    for (const [, target] of read.parts['xl/_rels/workbook.xml.rels'].matchAll(
      /Target="([^"]+)"/g,
    )) {
      expect(read.parts[`xl/${target}`]).toBeDefined();
    }
    expect(read.parts['xl/workbook.xml']).toContain(
      '<sheet name="purchases" sheetId="1" r:id="rId1"/>',
    );
    // The hidden filter range is the autofilter's, known only once the sheet is written.
    expect(read.parts['xl/worksheets/sheet1.xml']).toContain(
      '<autoFilter ref="A1:E3"/>',
    );
    expect(read.parts['xl/workbook.xml']).toContain("'purchases'!$A$1:$E$3");
  });

  it('round-trips the CSV columns as typed cells, the header bold, formulas as plain text', async () => {
    const read = await readXlsx(
      await collectBuffer(
        streamXlsx({
          columns: COLUMNS,
          batches: batchesOf(ROWS.slice(0, 1), [], ROWS.slice(1)),
          sheetName: 'assets',
        }),
      ),
    );

    const header = [...read.rows.get(1)!.values()];
    expect(header.map((c) => c.value)).toEqual(COLUMNS.map((c) => c.header));
    expect(header.every((c) => c.style === XLSX_STYLE.header)).toBe(true);

    const [first, second] = xlsxRecords(read);
    expect(first).toEqual({
      name: { ref: 'A2', style: 0, type: 'inlineStr', value: 'Laptop' },
      qty: { ref: 'B2', style: 0, type: 'n', value: '2' },
      cost: { ref: 'C2', style: XLSX_STYLE.money, type: 'n', value: '1500.50' },
      currency: { ref: 'D2', style: 0, type: 'inlineStr', value: 'USD' },
      at: { ref: 'E2', style: XLSX_STYLE.date, type: 'n', value: '46311' },
    });
    expect(second).toEqual({
      name: {
        ref: 'A3',
        style: 0,
        type: 'inlineStr',
        value: '=HYPERLINK("http://evil","x")',
      },
      qty: { ref: 'B3', style: 0, type: 'n', value: '-5' },
      at: {
        ref: 'E3',
        style: XLSX_STYLE.dateTime,
        type: 'n',
        value: '46311.5',
      },
    });
    // No cell is ever a formula.
    expect(read.parts['xl/worksheets/sheet1.xml']).not.toMatch(/<f[ >]/);
  });
});

describe('streamXlsx — failure and abandonment', () => {
  it('a batch failing mid-stream errors the output instead of ending it', async () => {
    const boom = new Error('db down');
    async function* failing(): AsyncGenerator<Row[]> {
      yield await Promise.resolve(ROWS);
      throw boom;
    }
    const out = streamXlsx({
      columns: COLUMNS,
      batches: failing(),
      sheetName: 'x',
    });
    await expect(collectBuffer(out)).rejects.toBe(boom);
  });

  it('destroying the output stops the batch reads and closes it', async () => {
    let reads = 0;
    async function* endless(): AsyncGenerator<Row[]> {
      for (;;) {
        reads += 1;
        yield await Promise.resolve(
          Array.from({ length: 1000 }, () => ROWS[0]),
        );
      }
    }
    const out = streamXlsx({
      columns: COLUMNS,
      batches: endless(),
      sheetName: 'x',
    });
    const closed = new Promise((resolve) => out.once('close', resolve));
    await new Promise<void>((resolve) => out.once('data', () => resolve()));
    out.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads).toBe(after);
  });

  it('emits close after a successful end, so the export slot is released', async () => {
    const out = streamXlsx({
      columns: COLUMNS,
      batches: batchesOf(ROWS),
      sheetName: 'x',
    });
    const closed = new Promise((resolve) => out.once('close', resolve));
    await collectBuffer(out);
    await expect(closed).resolves.toBeUndefined();
  });
});

describe('streamXlsx — memory stays bounded at the 100,000-row cap', () => {
  const ROW_COUNT = 100_000;
  const BATCH = 1000;
  // Incompressible text (a fixed-seed hash per cell), so even the DEFLATED sheet is a multiple of the
  // bound: an entry JSZip held to learn its size and CRC (streamFiles off) would fail this test.
  const noise = (i: number, c: number) => {
    let x = (i * 31 + c + 1) * 2654435761;
    let out = '';
    for (let k = 0; k < 14; k++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out += (x >>> 0).toString(36).padStart(7, '0');
    }
    return out;
  };
  const WIDE: ExportColumn<number>[] = Array.from({ length: 20 }, (_, c) => ({
    header: `column${c}`,
    kind:
      c % 4 === 1
        ? 'number'
        : c % 4 === 2
          ? 'money'
          : c % 4 === 3
            ? 'date'
            : 'text',
    value: (i: number) =>
      c % 4 === 1
        ? i * c
        : c % 4 === 2
          ? i * 101
          : c % 4 === 3
            ? new Date(Date.UTC(2020, 0, 1) + i * 60_000)
            : `${noise(i, c)} & <${c}>`,
  }));
  // Measured: ~18 MB streaming (the spike: flat from 100k to 300k rows) against ~70 MB with the entry
  // buffered, which holds at least the whole ~45 MB compressed sheet.
  const MEMORY_BOUND = 32 * 1024 * 1024;

  let rowsRead = 0;
  let sample: () => void = () => undefined;
  async function* rows(): AsyncGenerator<number[]> {
    for (let start = 0; start < ROW_COUNT; start += BATCH) {
      rowsRead += BATCH;
      // Sampled on the read side too: a buffered entry grows here while no output is emitted.
      if (rowsRead % (10 * BATCH) === 0) sample();
      yield await Promise.resolve(
        Array.from({ length: BATCH }, (_, i) => start + i),
      );
    }
  }

  it('streams a file larger than the bound while holding less than it', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const used = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    gc();
    const base = used();
    let peak = 0;
    let zipBytes = 0;
    let chunks = 0;
    rowsRead = 0;
    sample = () => {
      gc();
      peak = Math.max(peak, used() - base);
    };
    const out = streamXlsx({
      columns: WIDE,
      batches: rows(),
      sheetName: 'assets',
    });
    for await (const chunk of out) {
      zipBytes += (chunk as Buffer).length;
      if (++chunks % 100 === 0) sample();
    }

    expect(rowsRead).toBe(ROW_COUNT);
    expect(zipBytes).toBeGreaterThan(MEMORY_BOUND);
    expect(chunks).toBeGreaterThan(100);
    expect(peak).toBeLessThan(MEMORY_BOUND);
  }, 180_000);
});
