/**
 * Shared number formatting for all report renderers. One rule set so
 * the terminal table, the markdown report, and the detail blocks never
 * disagree: quality to three decimals, milliseconds and MiB as whole
 * numbers, rates and percents to one decimal, never a wall of digits.
 */

import type { Spread } from './aggregate.js';

/** Quality score, three decimals: 0.833. */
export const fmtScore = (value: number): string => value.toFixed(3);

/** Milliseconds, whole number: 412. */
export const fmtMs = (value: number): string => value.toFixed(0);

/** Tokens per second, one decimal: 25.2. */
export const fmtRate = (value: number): string => value.toFixed(1);

/** MiB, whole number: 4212. */
export const fmtMib = (value: number): string => value.toFixed(0);

/** Percent, one decimal and an explicit sign for deltas: +5.3. */
export const fmtSignedPercent = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;

/**
 * A value with its spread, or a placeholder when unmeasured.
 *
 * @param value - The mean or median.
 * @param spread - Min and max of the underlying samples.
 * @param fmt - Formatter applied to all three numbers.
 * @param missing - Placeholder when value is null.
 * @returns e.g. "0.833 (0.81..0.85)" or the placeholder.
 */
export function fmtWithSpread(
  value: number | null,
  spread: Spread | null,
  fmt: (n: number) => string,
  missing = '-',
): string {
  if (value === null) {
    return missing;
  }
  if (spread === null || spread.max - spread.min < 1e-9) {
    return fmt(value);
  }
  return `${fmt(value)} (${fmt(spread.min)}..${fmt(spread.max)})`;
}

/**
 * Wraps one prose line on spaces so terminal output never relies on
 * the terminal's own hard wrapping.
 *
 * @param text - The line to wrap; existing newlines are not handled.
 * @param width - Maximum line length, default 100.
 * @param continuationIndent - Prefix for wrapped continuation lines.
 * @returns One or more lines, each within the width (except a single
 *   word longer than the width, which stays intact).
 */
export function wrapLine(text: string, width = 100, continuationIndent = '    '): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const prefix = lines.length === 0 ? '' : continuationIndent;
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && prefix.length + candidate.length > width) {
      lines.push((lines.length === 0 ? '' : continuationIndent) + current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push((lines.length === 0 ? '' : continuationIndent) + current);
  return lines;
}

/**
 * Renders rows as a fixed-width text table.
 *
 * @param header - Column titles.
 * @param rows - Cell values, one array per row.
 * @param rightAlign - Column indexes to right-align (numeric columns).
 * @returns Lines with columns padded to their widest cell, two spaces
 *   between columns, no trailing whitespace.
 */
export function renderColumns(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  rightAlign: readonly number[] = [],
): string[] {
  const widths = header.map((title, col) =>
    Math.max(title.length, ...rows.map((row) => (row[col] ?? '').length)),
  );
  const right = new Set(rightAlign);
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, col) => {
        const width = widths[col] ?? cell.length;
        return right.has(col) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();
  return [renderRow(header), ...rows.map(renderRow)];
}
