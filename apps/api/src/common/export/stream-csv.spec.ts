import type { ExportColumn } from './export-column';
import { streamCsv } from './stream-csv';

interface Row {
  name: string;
  qty: number;
  cost: number | bigint | null;
  at: Date | null;
}

const COLUMNS: ExportColumn<Row>[] = [
  { header: 'name', kind: 'text', value: (r) => r.name },
  { header: 'qty', kind: 'number', value: (r) => r.qty },
  { header: 'cost', kind: 'money', value: (r) => r.cost },
  { header: 'at', kind: 'date', value: (r) => r.at },
];

async function* batchesOf<T>(...batches: T[][]): AsyncGenerator<T[]> {
  for (const batch of batches) yield await Promise.resolve(batch);
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}

describe('streamCsv', () => {
  it('writes the BOM, the header and CRLF-terminated rows', async () => {
    const csv = await collect(
      streamCsv({
        columns: COLUMNS,
        batches: batchesOf(
          [{ name: 'Laptop', qty: 2, cost: 150050, at: null }],
          [],
          [
            {
              name: 'Dock',
              qty: 1,
              cost: null,
              at: new Date('2026-10-16T12:00:00.000Z'),
            },
          ],
        ),
      }),
    );
    expect(csv).toBe(
      '\uFEFFname,qty,cost,at\r\n' +
        'Laptop,2,1500.50,\r\n' +
        'Dock,1,,2026-10-16T12:00:00.000Z\r\n',
    );
  });

  it('puts the stamp between the BOM and the header only when asked', async () => {
    const stamped = await collect(
      streamCsv({
        columns: COLUMNS,
        batches: batchesOf<Row>(),
        stamp: '# lazyit v2.0.0 — 2026-10-16T00:00:00.000Z',
      }),
    );
    expect(stamped).toBe(
      '\uFEFF# lazyit v2.0.0 — 2026-10-16T00:00:00.000Z\r\nname,qty,cost,at\r\n',
    );
    const plain = await collect(
      streamCsv({ columns: COLUMNS, batches: batchesOf<Row>() }),
    );
    expect(plain).toBe('\uFEFFname,qty,cost,at\r\n');
  });

  it('guards text cells only: a negative number or amount stays a number', async () => {
    const csv = await collect(
      streamCsv({
        columns: COLUMNS,
        batches: batchesOf([
          { name: '=cmd|/c calc', qty: -5, cost: -150, at: null },
          { name: '\uFF0B1', qty: 0, cost: 200n, at: null },
          { name: '\nnotes', qty: 1, cost: -7n, at: null },
        ]),
      }),
    );
    const rows = csv.split('\r\n').slice(1, 4);
    expect(rows[0]).toBe("'=cmd|/c calc,-5,-1.50,");
    expect(rows[1]).toBe("'\uFF0B1,0,2,");
    expect(csv).toContain(`"'\nnotes",1,-0.07,`);
  });
});
