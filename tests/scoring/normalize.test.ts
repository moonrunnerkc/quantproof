import { describe, expect, it } from 'vitest';
import { normalizeScalar, normalizeText, parseFirstNumber } from '../../src/scoring/normalize.js';

describe('normalizeText', () => {
  const cases: readonly [name: string, input: string, expected: string][] = [
    ['trims surrounding whitespace', '  hello  ', 'hello'],
    ['folds case', 'ACME Corp', 'acme corp'],
    ['collapses internal whitespace runs', 'acme \t\n corp', 'acme corp'],
    ['applies unicode NFKC so fullwidth letters match ascii', 'ｂｕｇ', 'bug'],
    ['normalizes the ligature ﬁ to fi', 'ﬁnance', 'finance'],
    ['leaves an already-normal string alone', 'billing', 'billing'],
    ['returns empty string for whitespace-only input', ' \t ', ''],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe('parseFirstNumber', () => {
  const cases: readonly [name: string, input: string, value: number | null][] = [
    ['parses a bare integer', 'the answer is 42', 42],
    ['parses a decimal', 'total 3.14 exactly', 3.14],
    ['parses a currency amount with thousands separators', 'Total due: $4,820.50', 4820.5],
    ['parses a euro amount', '€1,000.00 flat', 1000],
    ['parses a percent as its face value', 'growth of 42%', 42],
    ['parses a negative number', 'delta was -17.5 today', -17.5],
    ['parses minus after the currency symbol', 'balance $-250.00', -250],
    ['parses fullwidth digits via NFKC', '４２ units', 42],
    ['takes the first number when several appear', '10 out of 50', 10],
    ['returns null when there is no number', 'no digits here', null],
    ['returns null for numbers written as words', 'forty-two', null],
    ['returns null for empty string', '', null],
  ];
  it.each(cases)('%s', (_name, input, value) => {
    const parsed = parseFirstNumber(input);
    if (value === null) {
      expect(parsed).toBeNull();
    } else {
      expect(parsed?.value).toBe(value);
    }
  });

  it('reports the raw matched token', () => {
    expect(parseFirstNumber('pay $1,234.56 now')?.raw).toBe('$1,234.56');
  });
});

describe('normalizeScalar', () => {
  it('normalizes strings for comparison', () => {
    expect(normalizeScalar('  Acme  CORP ')).toBe('acme corp');
  });
  it('treats a purely numeric string as its number so "$1,234.50" equals 1234.5', () => {
    expect(normalizeScalar('$1,234.50')).toBe(1234.5);
    expect(normalizeScalar('1234.5')).toBe(1234.5);
  });
  it('does not numify strings with trailing prose', () => {
    expect(normalizeScalar('42 units')).toBe('42 units');
  });
  it('passes numbers, booleans, and null through unchanged', () => {
    expect(normalizeScalar(7)).toBe(7);
    expect(normalizeScalar(true)).toBe(true);
    expect(normalizeScalar(null)).toBeNull();
  });
});
