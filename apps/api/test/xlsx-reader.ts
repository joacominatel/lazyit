// Test-only reader for the export engine's XLSX (ADR-0103 §11): unzips a workbook, checks every
// XML part is well formed, and reads the one sheet back as typed cells. Not a general XLSX parser.
import JSZip from 'jszip';

export interface XlsxCellRead {
  ref: string;
  style: number;
  type: 'inlineStr' | 'n';
  /** The decoded text of an inline string, or the raw `<v>` of a number. */
  value: string;
}

export interface XlsxRead {
  zip: JSZip;
  parts: Record<string, string>;
  /** Rows by row number, each a map from column letters to the cell. */
  rows: Map<number, Map<string, XlsxCellRead>>;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/** XML entities, then ECMA-376 `_xHHHH_` escapes (either hex case), as Excel decodes an inline string. */
export function decodeXlsxText(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e])
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;

/** Throws unless `xml` is one declaration plus balanced elements with no stray `<` or `&`. */
export function assertWellFormedXml(xml: string, part: string): void {
  const body = xml.replace(/^<\?xml [^?]*\?>\s*/, '');
  const stack: string[] = [];
  let last = 0;
  let roots = 0;
  for (const m of body.matchAll(TAG)) {
    const between = body.slice(last, m.index);
    if (/[<]|&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(between)) {
      throw new Error(`${part}: stray markup before offset ${m.index}`);
    }
    last = m.index + m[0].length;
    const [, close, name, , selfClose] = m;
    if (close) {
      const open = stack.pop();
      if (open !== name)
        throw new Error(`${part}: </${name}> closes <${open}>`);
    } else if (!selfClose) {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) {
      roots += 1;
    }
  }
  if (body.slice(last).trim() !== '')
    throw new Error(`${part}: trailing content`);
  if (stack.length > 0) throw new Error(`${part}: unclosed <${stack.pop()}>`);
  if (roots !== 1) throw new Error(`${part}: ${roots} root elements`);
}

const CELL =
  /<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?(?: t="(inlineStr)")?>(?:<is><t xml:space="preserve">([\s\S]*?)<\/t><\/is>|<v>([^<]*)<\/v>)<\/c>/g;

export async function readXlsx(buffer: Buffer): Promise<XlsxRead> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    const text = await zip.file(name)!.async('string');
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      assertWellFormedXml(text, name);
    }
    parts[name] = text;
  }
  const rows = new Map<number, Map<string, XlsxCellRead>>();
  const sheet = parts['xl/worksheets/sheet1.xml'] ?? '';
  for (const m of sheet.matchAll(CELL)) {
    const [, col, row, style, inline, text, v] = m;
    const n = Number(row);
    if (!rows.has(n)) rows.set(n, new Map());
    rows.get(n)!.set(col, {
      ref: `${col}${row}`,
      style: style === undefined ? 0 : Number(style),
      type: inline ? 'inlineStr' : 'n',
      value: inline ? decodeXlsxText(text) : v,
    });
  }
  return { zip, parts, rows };
}

/** The sheet as header-keyed records: header row 1 names each column letter. */
export function xlsxRecords(read: XlsxRead): Record<string, XlsxCellRead>[] {
  const header = read.rows.get(1);
  if (!header) return [];
  const names = new Map([...header].map(([col, cell]) => [col, cell.value]));
  const out: Record<string, XlsxCellRead>[] = [];
  const numbers = [...read.rows.keys()]
    .filter((n) => n > 1)
    .sort((a, b) => a - b);
  for (const n of numbers) {
    const record: Record<string, XlsxCellRead> = {};
    for (const [col, cell] of read.rows.get(n)!) record[names.get(col)!] = cell;
    out.push(record);
  }
  return out;
}

export async function collectBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
