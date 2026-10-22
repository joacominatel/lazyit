import {
  columnLetter,
  excelSerial,
  streamSheetXml,
  XLSX_MAX_CELL_CHARS,
  XLSX_STYLE,
  xlsxCell,
  xlsxSheetName,
  xlsxText,
  xlsxWorkbook,
} from './xlsx-sheet';
import type { ExportColumn } from './export-column';
import { assertWellFormedXml, decodeXlsxText } from '../../../test/xlsx-reader';

describe('columnLetter', () => {
  it.each([
    [0, 'A'],
    [25, 'Z'],
    [26, 'AA'],
    [51, 'AZ'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('%i → %s', (index, letters) => {
    expect(columnLetter(index)).toBe(letters);
  });
});

describe('xlsxText — an inline string body', () => {
  it('escapes XML markup', () => {
    expect(xlsxText('<b>Tom & "Jerry"</b>')).toBe(
      '&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;',
    );
  });

  it('keeps a formula as literal text: no guard, nothing to evaluate', () => {
    expect(xlsxText('=HYPERLINK("http://x")')).toBe(
      '=HYPERLINK(&quot;http://x&quot;)',
    );
    expect(xlsxText('-5')).toBe('-5');
  });

  it('writes control characters as _xHHHH_ and keeps tab and LF', () => {
    expect(xlsxText('a\u0001b\u000Bc\rd\te\nf')).toBe(
      'a_x0001_b_x000B_c_x000D_d\te\nf',
    );
  });

  it('keeps a literal _xHHHH_ literal', () => {
    const out = xlsxText('id_x0041_end');
    expect(out).toBe('id_x005F_x0041_end');
    expect(decodeXlsxText(out)).toBe('id_x0041_end');
  });

  it('keeps chained _xHHHH_ escapes that share an underscore literal', () => {
    const out = xlsxText('_x0041_x0042_');
    expect(out).toBe('_x005F_x0041_x005F_x0042_');
    expect(decodeXlsxText(out)).toBe('_x0041_x0042_');
  });

  it('round-trips every character Excel can hold', () => {
    const value = 'José 😀 ＝1+1 \u0002 _x00e9_ <&>';
    expect(decodeXlsxText(xlsxText(value))).toBe(value);
  });

  it('replaces what XML cannot hold: lone surrogates, U+FFFE, U+FFFF', () => {
    expect(xlsxText('a\uD800b\uDC00c\uFFFEd\uFFFF')).toBe(
      'a\uFFFDb\uFFFDc\uFFFDd\uFFFD',
    );
  });

  it("cuts a text above Excel's cell limit without splitting a surrogate pair", () => {
    expect(xlsxText('x'.repeat(XLSX_MAX_CELL_CHARS + 10))).toHaveLength(
      XLSX_MAX_CELL_CHARS,
    );
    const pairAtCut = `${'x'.repeat(XLSX_MAX_CELL_CHARS - 1)}😀tail`;
    expect(xlsxText(pairAtCut)).toBe('x'.repeat(XLSX_MAX_CELL_CHARS - 1));
  });
});

describe('excelSerial', () => {
  it('maps UTC instants onto the 1900 date system', () => {
    expect(excelSerial(new Date('2026-10-16T00:00:00.000Z'))).toBe(46311);
    expect(excelSerial(new Date('2026-10-16T12:00:00.000Z'))).toBe(46311.5);
    expect(excelSerial(new Date('1900-03-01T00:00:00.000Z'))).toBe(61);
  });

  it('refuses dates the 1900 leap-year bug would shift', () => {
    expect(excelSerial(new Date('1900-02-28T00:00:00.000Z'))).toBeNull();
  });
});

describe('xlsxCell — typed cells', () => {
  const inline = (ref: string, body: string, style = 0) =>
    `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${body}</t></is></c>`;

  it('null and undefined are empty cells', () => {
    for (const kind of ['text', 'number', 'date', 'money'] as const) {
      expect(xlsxCell('A2', null, kind)).toBeNull();
      expect(xlsxCell('A2', undefined, kind)).toBeNull();
    }
  });

  it('text is always an inline string, even when it looks like a number', () => {
    expect(xlsxCell('A2', '=1+1', 'text')).toBe(inline('A2', '=1+1'));
    expect(xlsxCell('A2', '00123', 'text')).toBe(inline('A2', '00123'));
    expect(xlsxCell('A2', 7, 'text')).toBe(inline('A2', '7'));
  });

  it('number is a number cell, negative included', () => {
    expect(xlsxCell('B2', 5, 'number')).toBe('<c r="B2"><v>5</v></c>');
    expect(xlsxCell('B2', -5, 'number')).toBe('<c r="B2"><v>-5</v></c>');
    expect(xlsxCell('B2', 12n, 'number')).toBe('<c r="B2"><v>12</v></c>');
    expect(xlsxCell('B2', '-3.5', 'number')).toBe('<c r="B2"><v>-3.5</v></c>');
    expect(xlsxCell('B2', Number.NaN, 'number')).toBeNull();
    expect(xlsxCell('B2', '=cmd', 'number')).toBe(inline('B2', '=cmd'));
  });

  it('money is the exact major-unit number in #,##0.00', () => {
    const money = (v: string) =>
      `<c r="C2" s="${XLSX_STYLE.money}"><v>${v}</v></c>`;
    expect(xlsxCell('C2', 150050, 'money')).toBe(money('1500.50'));
    expect(xlsxCell('C2', -1999, 'money')).toBe(money('-19.99'));
    expect(xlsxCell('C2', 9_007_199_254_740_993n, 'money')).toBe(
      money('90071992547409.93'),
    );
    expect(xlsxCell('C2', 0, 'money')).toBe(money('0'));
    expect(xlsxCell('C2', '12.50', 'money')).toBe(money('12.50'));
    expect(xlsxCell('C2', 'n/a', 'money')).toBe(inline('C2', 'n/a'));
  });

  it('a date is a real date: date-only at UTC midnight, else date and time', () => {
    expect(xlsxCell('D2', new Date('2026-10-16T00:00:00.000Z'), 'date')).toBe(
      `<c r="D2" s="${XLSX_STYLE.date}"><v>46311</v></c>`,
    );
    expect(xlsxCell('D2', new Date('2026-10-16T12:00:00.000Z'), 'date')).toBe(
      `<c r="D2" s="${XLSX_STYLE.dateTime}"><v>46311.5</v></c>`,
    );
    expect(xlsxCell('D2', '2026-10-16', 'date')).toBe(
      `<c r="D2" s="${XLSX_STYLE.date}"><v>46311</v></c>`,
    );
  });

  it('a date Excel cannot show is kept as ISO text; an invalid one is empty', () => {
    expect(xlsxCell('D2', new Date('1899-12-31T00:00:00.000Z'), 'date')).toBe(
      inline('D2', '1899-12-31T00:00:00.000Z'),
    );
    expect(xlsxCell('D2', new Date('nope'), 'date')).toBeNull();
    expect(xlsxCell('D2', 'soon', 'date')).toBe(inline('D2', 'soon'));
  });
});

describe('xlsxSheetName and xlsxWorkbook', () => {
  it("follows Excel's sheet-name rules", () => {
    expect(xlsxSheetName('purchases')).toBe('purchases');
    expect(xlsxSheetName('a/b:c*d?[e]\\f')).toBe('a b c d  e  f');
    expect(xlsxSheetName('x'.repeat(40))).toHaveLength(31);
    expect(xlsxSheetName(' / ')).toBe('Sheet1');
  });

  it('names the autofilter range as _FilterDatabase, quoting the sheet', () => {
    const xml = xlsxWorkbook("Bob's & co", 17, 4);
    assertWellFormedXml(xml, 'workbook.xml');
    expect(xml).toContain(
      '<sheet name="Bob\'s &amp; co" sheetId="1" r:id="rId1"/>',
    );
    expect(xml).toContain(
      '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'Bob\'\'s &amp; co\'!$A$1:$Q$4</definedName>',
    );
  });
});

describe('streamSheetXml', () => {
  interface Row {
    name: string;
    qty: number;
  }
  const COLUMNS: ExportColumn<Row>[] = [
    { header: 'name', kind: 'text', value: (r) => r.name },
    { header: 'qty', kind: 'number', value: (r) => r.qty },
  ];

  async function* batches(...b: Row[][]): AsyncGenerator<Row[]> {
    for (const rows of b) yield await Promise.resolve(rows);
  }

  async function sheet(...b: Row[][]) {
    let total = -1;
    let xml = '';
    for await (const chunk of streamSheetXml({
      columns: COLUMNS,
      batches: batches(...b),
      onEnd: (n) => (total = n),
    })) {
      xml += chunk.toString('utf8');
    }
    return { xml, total };
  }

  it('writes a frozen bold header, one row per record and an autofilter over them', async () => {
    const { xml, total } = await sheet(
      [{ name: 'Laptop', qty: 2 }],
      [],
      [{ name: '<Dock>', qty: -1 }],
    );
    assertWellFormedXml(xml, 'sheet1.xml');
    expect(total).toBe(3);
    expect(xml).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(xml).toContain(
      `<row r="1"><c r="A1" s="${XLSX_STYLE.header}" t="inlineStr">`,
    );
    expect(xml).toContain(
      '<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">&lt;Dock&gt;</t></is></c><c r="B3"><v>-1</v></c></row>',
    );
    expect(xml).toMatch(
      /<\/sheetData><autoFilter ref="A1:B3"\/><\/worksheet>$/,
    );
  });

  it('an empty export is a header with an autofilter over it', async () => {
    const { xml, total } = await sheet();
    assertWellFormedXml(xml, 'sheet1.xml');
    expect(total).toBe(1);
    expect(xml).toContain('<autoFilter ref="A1:B1"/>');
  });
});
