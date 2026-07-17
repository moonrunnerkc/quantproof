import { describe, expect, it } from 'vitest';
import {
  fmtMib,
  fmtMs,
  fmtRate,
  fmtScore,
  fmtSignedPercent,
  fmtWithSpread,
  renderColumns,
} from '../../src/report/format.js';

describe('number formatters', () => {
  it('keep digits terse: 3-decimal scores, whole ms and MiB, 1-decimal rates', () => {
    expect(fmtScore(0.8333333)).toBe('0.833');
    expect(fmtMs(412.37)).toBe('412');
    expect(fmtMib(4212.49)).toBe('4212');
    expect(fmtRate(25.249)).toBe('25.2');
  });

  it('signs percent deltas explicitly in both directions', () => {
    expect(fmtSignedPercent(5.31)).toBe('+5.3');
    expect(fmtSignedPercent(-12.04)).toBe('-12.0');
  });
});

describe('fmtWithSpread', () => {
  it('renders the value with its min..max spread', () => {
    expect(fmtWithSpread(0.833, { min: 0.81, max: 0.85 }, fmtScore)).toBe('0.833 (0.810..0.850)');
  });

  it('drops the spread when it is effectively zero', () => {
    expect(fmtWithSpread(1, { min: 1, max: 1 }, fmtScore)).toBe('1.000');
  });

  it('renders the placeholder for a missing value', () => {
    expect(fmtWithSpread(null, null, fmtScore)).toBe('-');
    expect(fmtWithSpread(null, null, fmtScore, 'n/m')).toBe('n/m');
  });
});

describe('renderColumns', () => {
  it('pads columns to the widest cell and right-aligns numeric columns', () => {
    const lines = renderColumns(
      ['model', 'tok/s'],
      [
        ['gemma3:1b', '25.2'],
        ['a-much-longer-model-name', '4.1'],
      ],
      [1],
    );
    expect(lines).toEqual([
      'model                     tok/s',
      'gemma3:1b                  25.2',
      'a-much-longer-model-name    4.1',
    ]);
  });

  it('never emits trailing whitespace', () => {
    const lines = renderColumns(['a', 'b'], [['x', '']], []);
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
