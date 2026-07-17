/**
 * Shared text and number normalization for scorers.
 *
 * Every scorer that compares text or parses numbers goes through this
 * module so that "Acme Corp " and "acme  corp" compare equal everywhere,
 * not just in the scorer someone happened to fix.
 */

/**
 * Normalizes text for comparison: unicode NFKC, trim, case fold, and
 * collapse of internal whitespace runs to a single space.
 *
 * @param text - Raw text as produced by a model or a pack author.
 * @returns The normalized form. Never throws.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A number successfully parsed out of text, with the exact substring it
 * came from so score details can show what was compared.
 */
export interface ParsedNumber {
  readonly value: number;
  readonly raw: string;
}

const NUMBER_PATTERN =
  /-?[$€£¥]?\s?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|-?[$€£¥]?\s?-?\d+(?:\.\d+)?%?/u;

/**
 * Finds the first number in a piece of text, tolerating the formats
 * local models actually emit: currency symbols ($1,234.56), thousands
 * separators, percent signs (42% parses as 42), and leading minus on
 * either side of a currency symbol (-$5 and $-5 both parse as -5).
 *
 * Does not parse numbers written as words ("forty-two" returns null);
 * that is a deliberate limit, not an oversight.
 *
 * @param text - Text that may contain a number.
 * @returns The first parsed number with its raw matched substring, or
 *   null when no numeric token exists. Never throws.
 */
export function parseFirstNumber(text: string): ParsedNumber | null {
  const match = NUMBER_PATTERN.exec(text.normalize('NFKC'));
  if (match === null) {
    return null;
  }
  const raw = match[0];
  const negative = raw.includes('-');
  const digits = raw.replace(/[^0-9.]/g, '');
  const value = Number.parseFloat(digits);
  if (Number.isNaN(value)) {
    return null;
  }
  return { value: negative ? -value : value, raw };
}

/**
 * Normalizes a scalar for field comparison. Strings are text-normalized;
 * strings that are purely numeric (after currency/percent stripping)
 * compare as numbers so "$1,234.50" matches 1234.5. Numbers, booleans,
 * and null pass through.
 *
 * @param value - A scalar from model output or an expected file.
 * @returns A primitive suitable for strict equality comparison.
 */
export function normalizeScalar(
  value: string | number | boolean | null,
): string | number | boolean | null {
  if (typeof value !== 'string') {
    return value;
  }
  const normalized = normalizeText(value);
  const parsed = parseFirstNumber(normalized);
  if (parsed !== null && parsed.raw === normalized) {
    return parsed.value;
  }
  return normalized;
}
