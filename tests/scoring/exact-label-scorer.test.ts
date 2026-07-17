import { describe, expect, it } from 'vitest';
import { exactLabelScorer } from '../../src/scoring/exact-label-scorer.js';

const params = {
  labels: ['billing', 'bug', 'feature-request', 'other'],
  aliases: { 'bug report': 'bug', defect: 'bug', enhancement: 'feature-request' },
};

describe('exactLabelScorer', () => {
  const table: readonly [name: string, output: string, expected: string, score: number][] = [
    ['scores 1 for an exact label', 'bug', 'bug', 1],
    ['scores 1 for a label in different case with padding', '  Billing \n', 'billing', 1],
    ['scores 1 for a declared alias', 'bug report', 'bug', 1],
    ['scores 1 for an alias in mixed case', 'Bug Report', 'bug', 1],
    ['scores 1 for fullwidth unicode lookalike of a label via NFKC', 'ｂｕｇ', 'bug', 1],
    ['scores 0 for the wrong label', 'billing', 'bug', 0],
    ['scores 0 for an alias of the wrong label', 'enhancement', 'bug', 0],
    ['scores 0 for prose around the label', 'The category is: bug', 'bug', 0],
    ['scores 0 for refusal text', 'I cannot classify this ticket.', 'bug', 0],
    ['scores 0 for empty output', '', 'bug', 0],
    ['scores 0 for a made-up label', 'critical', 'bug', 0],
  ];
  it.each(table)('%s', (_name, output, expected, score) => {
    const record = exactLabelScorer(output, expected, params);
    expect(record.score).toBe(score);
    expect(record.pass).toBe(score === 1);
  });

  it('keeps the raw output in details for off-label answers', () => {
    const record = exactLabelScorer('The category is: bug', 'bug', params);
    expect(record.details['rawOutput']).toBe('The category is: bug');
    expect(record.details['resolvedLabel']).toBeNull();
  });

  it('reports the resolved canonical label for alias matches', () => {
    const record = exactLabelScorer('defect', 'bug', params);
    expect(record.details['resolvedLabel']).toBe('bug');
  });

  it('throws a pack-authoring error when the expected value is off-label', () => {
    expect(() => exactLabelScorer('bug', 'not-a-label', params)).toThrow(/not in labels/);
  });

  it('throws a pack-authoring error when the expected value is not a string', () => {
    expect(() => exactLabelScorer('bug', 7, params)).toThrow(/not in labels/);
  });

  it('throws a pack-authoring error when an alias targets an undeclared label', () => {
    expect(() =>
      exactLabelScorer('bug', 'bug', { labels: ['bug'], aliases: { crash: 'incident' } }),
    ).toThrow(/points at "incident"/);
  });

  it('throws a pack-authoring error when labels is missing', () => {
    expect(() => exactLabelScorer('bug', 'bug', {})).toThrow(/labels/);
  });

  it('accepts an expected value written as an alias and resolves it canonically', () => {
    expect(exactLabelScorer('bug', 'defect', params).pass).toBe(true);
  });
});
