import { describe, expect, it } from 'vitest';
import { numericToleranceScorer } from '../../src/scoring/numeric-tolerance-scorer.js';

describe('numericToleranceScorer', () => {
  const table: readonly [name: string, output: string, expected: number, params: Record<string, unknown>, pass: boolean][] = [
    ['passes an exact bare number at zero tolerance', '42', 42, { tolerance: 0 }, true],
    ['passes within absolute tolerance', '41.5', 42, { tolerance: 1 }, true],
    ['fails outside absolute tolerance', '40', 42, { tolerance: 1 }, false],
    ['passes a currency-formatted answer', 'The total is $4,820.50.', 4820.5, { tolerance: 0 }, true],
    ['passes a percent-formatted answer at face value', 'Growth was 12.5% year over year', 12.5, { tolerance: 0 }, true],
    ['passes within relative tolerance', '102', 100, { tolerance: 0.02, mode: 'relative' }, true],
    ['fails outside relative tolerance', '103', 100, { tolerance: 0.02, mode: 'relative' }, false],
    ['passes a negative expected value', 'delta: -17.5', -17.5, { tolerance: 0 }, true],
    ['fails when the answer is a number written as words', 'forty-two', 42, { tolerance: 5 }, false],
    ['fails on refusal text with no number', 'I cannot calculate that.', 42, { tolerance: 5 }, false],
    ['fails on empty output', '', 42, { tolerance: 5 }, false],
    ['uses the first number when several appear', 'between 10 and 90', 10, { tolerance: 0 }, true],
    ['parses fullwidth unicode digits via NFKC', '４２', 42, { tolerance: 0 }, true],
  ];
  it.each(table)('%s', (_name, output, expected, params, pass) => {
    const record = numericToleranceScorer(output, expected, params);
    expect(record.pass).toBe(pass);
    expect(record.score).toBe(pass ? 1 : 0);
  });

  it('reports both values and the allowed difference in details', () => {
    const record = numericToleranceScorer('103', 100, { tolerance: 0.02, mode: 'relative' });
    expect(record.details).toMatchObject({
      expected: 100,
      actual: 103,
      difference: 3,
      allowedDifference: 2,
      mode: 'relative',
    });
  });

  it('explains a wordy-number failure in details', () => {
    const record = numericToleranceScorer('forty-two', 42, { tolerance: 5 });
    expect(record.details['reason']).toContain('numbers written as words');
  });

  it('throws a pack-authoring error when tolerance is missing', () => {
    expect(() => numericToleranceScorer('42', 42, {})).toThrow(/tolerance/);
  });

  it('throws a pack-authoring error when tolerance is negative', () => {
    expect(() => numericToleranceScorer('42', 42, { tolerance: -1 })).toThrow(/zero or positive/);
  });

  it('throws a pack-authoring error when the expected value is not a number', () => {
    expect(() => numericToleranceScorer('42', 'forty-two', { tolerance: 0 })).toThrow(
      /not a finite number/,
    );
  });
});
