import {
  inferDateOrder,
  inferDecimalSeparator,
  readAmount,
  readDate,
  readQuantity,
  revealedDecimal,
} from './document-values';

const minor = (value: number) => ({ ok: true, minor: value });
const fails = (reason: string) => ({ ok: false, reason });

describe('readAmount — printed amounts to minor units, never guessed (#1477)', () => {
  it.each([
    // Spanish / Argentine formats
    ['1.412.500,00', 141_250_000],
    ['1.234,56', 123_456],
    ['$ 1.234,5', 123_450],
    ['ARS 25.000,00', 2_500_000],
    ['0,99', 99],
    // English formats
    ['1,412,500.00', 141_250_000],
    ['USD 1,234.56', 123_456],
    ['u$s 1,250.00', 125_000],
    ['1234.5', 123_450],
    // Thousands by space / non-breaking space / apostrophe, labels on either side
    ['1 234,56 €', 123_456],
    ['1 234,56', 123_456],
    ["1'234.56 CHF", 123_456],
    // No separator at all
    ['4', 400],
    ['150000', 15_000_000],
    // Repeated separator = thousands grouping only
    ['1.234.567', 123_456_700],
    ['1,234,567', 123_456_700],
  ])('%s → %d', (text, expected) => {
    expect(readAmount(text)).toEqual(minor(expected));
  });

  it('a single separator before exactly three digits is ambiguous without a hint', () => {
    expect(readAmount('1.150')).toEqual(fails('AMBIGUOUS'));
    expect(readAmount('1,150')).toEqual(fails('AMBIGUOUS'));
  });

  it('the document hint settles it: grouping when the hint is the other separator', () => {
    expect(readAmount('1.150', ',')).toEqual(minor(115_000));
    expect(readAmount('1,150', '.')).toEqual(minor(115_000));
    // The hint IS that separator: three decimals, which hundredths cannot hold.
    expect(readAmount('1.150', '.')).toEqual(fails('TOO_PRECISE'));
  });

  it('more than two decimals is refused, never rounded', () => {
    expect(readAmount('1.2345')).toEqual(fails('TOO_PRECISE'));
    expect(readAmount('0,500')).toEqual(fails('TOO_PRECISE'));
    expect(readAmount('1.234,567')).toEqual(fails('TOO_PRECISE'));
  });

  it('a trailing minus is a negative amount (credit notes), never a label', () => {
    expect(readAmount('1.500,00-')).toEqual(fails('UNREADABLE'));
    expect(readAmount('1.500,00 −')).toEqual(fails('UNREADABLE'));
    expect(readAmount('USD 1,500.00-')).toEqual(fails('UNREADABLE'));
  });

  it('the Spanish "whole amount" mark is not a sign: `$ 1.500.-` is 1500', () => {
    expect(readAmount('$ 1.500.-')).toEqual(minor(150_000));
    expect(readAmount('1,500.-')).toEqual(minor(150_000));
    expect(revealedDecimal('$ 1.500.-')).toBe(',');
  });

  it('thousands grouped by spaces must be real groups of three', () => {
    expect(readAmount('1 234 567,89')).toEqual(minor(123_456_789));
    expect(readAmount('12 34')).toEqual(fails('UNREADABLE'));
    expect(readAmount('1 23,45')).toEqual(fails('UNREADABLE'));
    expect(readAmount('1234 567')).toEqual(fails('UNREADABLE'));
  });

  it('negative, malformed and oversized amounts do not read', () => {
    expect(readAmount('-1.234,56')).toEqual(fails('UNREADABLE'));
    expect(readAmount('(1,234.56)')).toEqual(fails('UNREADABLE'));
    expect(readAmount('12 abc 34')).toEqual(fails('UNREADABLE'));
    expect(readAmount('1.23.4')).toEqual(fails('UNREADABLE'));
    expect(readAmount('1,234.567.89')).toEqual(fails('UNREADABLE'));
    expect(readAmount('1,,2')).toEqual(fails('UNREADABLE'));
    // Trailing punctuation is not part of the number (a sentence's full stop).
    expect(readAmount('1234.')).toEqual(minor(123_400));
    expect(readAmount('$')).toEqual(fails('UNREADABLE'));
    expect(readAmount('99999999999999999999')).toEqual(fails('UNREADABLE'));
  });
});

describe('the document decimal separator (#1477)', () => {
  it('each literal reveals one only when it cannot be read two ways', () => {
    expect(revealedDecimal('1.234,56')).toBe(',');
    expect(revealedDecimal('1,234.56')).toBe('.');
    expect(revealedDecimal('1.234.567')).toBe(',');
    expect(revealedDecimal('12,5')).toBe(',');
    expect(revealedDecimal('1.150')).toBeNull();
    expect(revealedDecimal('4')).toBeNull();
  });

  it('the document agrees on one, or settles nothing', () => {
    expect(inferDecimalSeparator(['1.150', '4', '25.000,00', null])).toBe(',');
    expect(inferDecimalSeparator(['1.150', '4'])).toBeNull();
    expect(inferDecimalSeparator(['1.234,56', '1,234.56'])).toBeNull();
  });
});

describe('readQuantity (#1477)', () => {
  it('reads whole units in either format', () => {
    expect(readQuantity('4')).toEqual({ ok: true, quantity: 4 });
    expect(readQuantity('4,00')).toEqual({ ok: true, quantity: 4 });
    expect(readQuantity('1.000', ',')).toEqual({ ok: true, quantity: 1000 });
  });

  it('refuses fractions, zero and ambiguity', () => {
    expect(readQuantity('4,5')).toEqual({ ok: false, reason: 'NOT_WHOLE' });
    expect(readQuantity('0')).toEqual({ ok: false, reason: 'NOT_WHOLE' });
    expect(readQuantity('1.000')).toEqual({ ok: false, reason: 'AMBIGUOUS' });
  });
});

describe('dates (#1477)', () => {
  const day = (iso: string) => ({ ok: true, iso: `${iso}T00:00:00.000Z` });

  it('an unambiguous numeric date is read from the text, whatever the model said', () => {
    expect(readDate('25/03/2026', '2026-03-25')).toEqual(day('2026-03-25'));
    expect(readDate('2026-03-10', null)).toEqual(day('2026-03-10'));
    expect(readDate('25.03.26', '2027-01-01')).toEqual(day('2026-03-25'));
  });

  it('a date that reads both ways is left blank — blanks over guesses, even when the model picked one', () => {
    expect(readDate('10/03/2026', '2026-03-10')).toEqual({
      ok: false,
      reason: 'AMBIGUOUS',
    });
    expect(readDate('10/03/2026', null)).toEqual({
      ok: false,
      reason: 'AMBIGUOUS',
    });
  });

  it("the document's order settles an ambiguous date", () => {
    expect(inferDateOrder(['10/03/2026', '25/03/2026'])).toBe('DMY');
    expect(inferDateOrder(['03/25/2026'])).toBe('MDY');
    expect(inferDateOrder(['25/03/2026', '03/25/2026'])).toBeNull();
    expect(readDate('10/03/2026', '2026-10-03', 'DMY')).toEqual(
      day('2026-03-10'),
    );
  });

  it('a written date keeps the model reading when its year and day are printed', () => {
    expect(readDate('10 de marzo de 2026', '2026-03-10')).toEqual(
      day('2026-03-10'),
    );
    expect(readDate('marzo de 2026', '2026-03-10')).toEqual({
      ok: false,
      reason: 'UNREADABLE',
    });
    expect(readDate('10 de marzo de 2026', 'not a date')).toEqual({
      ok: false,
      reason: 'UNREADABLE',
    });
  });

  it('impossible dates do not read', () => {
    expect(readDate('31/02/2026', '2026-02-28')).toEqual({
      ok: false,
      reason: 'UNREADABLE',
    });
  });
});
