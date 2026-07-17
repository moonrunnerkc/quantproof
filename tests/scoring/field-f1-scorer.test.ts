import { describe, expect, it } from 'vitest';
import { fieldF1Scorer } from '../../src/scoring/field-f1-scorer.js';

const params = { key_fields: ['vendor', 'total', 'due_date'] };
const expected = { vendor: 'Acme Corp', total: 1234.5, due_date: '2026-06-01' };

describe('fieldF1Scorer', () => {
  it('scores 1 with pass when every key field matches exactly', () => {
    const record = fieldF1Scorer(JSON.stringify(expected), expected, params);
    expect(record.score).toBe(1);
    expect(record.pass).toBe(true);
    expect(record.details).toEqual({
      extractionNeeded: false,
      fields: { vendor: 'match', total: 'match', due_date: 'match' },
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });

  it('matches through normalization: case, whitespace, and currency-formatted numbers', () => {
    const output = '{"vendor": "  ACME  corp ", "total": "$1,234.50", "due_date": "2026-06-01"}';
    const record = fieldF1Scorer(output, expected, params);
    expect(record.pass).toBe(true);
  });

  it('computes f1 two-thirds when one of three fields is wrong', () => {
    const output = '{"vendor": "Acme Corp", "total": 999, "due_date": "2026-06-01"}';
    const record = fieldF1Scorer(output, expected, params);
    // 2 TP, 1 FP, 1 FN: precision 2/3, recall 2/3, f1 2/3.
    expect(record.details['precision']).toBe(2 / 3);
    expect(record.details['recall']).toBe(2 / 3);
    expect(record.score).toBe(2 / 3);
    expect(record.pass).toBe(false);
    expect((record.details['fields'] as Record<string, string>)['total']).toBe('mismatch');
  });

  it('computes f1 0.8 when one of three fields is missing', () => {
    const output = '{"vendor": "Acme Corp", "total": 1234.5}';
    const record = fieldF1Scorer(output, expected, params);
    // 2 TP, 0 FP, 1 FN: precision 1, recall 2/3, f1 = 2*(2/3)/(5/3) = 0.8.
    expect(record.details['precision']).toBe(1);
    expect(record.details['recall']).toBe(2 / 3);
    expect(record.score).toBe(0.8);
    expect((record.details['fields'] as Record<string, string>)['due_date']).toBe('missing');
  });

  it('scores extracted fenced JSON and flags the extraction', () => {
    const record = fieldF1Scorer('```json\n' + JSON.stringify(expected) + '\n```', expected, params);
    expect(record.pass).toBe(true);
    expect(record.details['extractionNeeded']).toBe(true);
  });

  it('scores zero for refusal prose with every field missing', () => {
    const record = fieldF1Scorer('Sorry, I cannot extract that.', expected, params);
    expect(record.score).toBe(0);
    expect(record.details['fields']).toEqual({ vendor: 'missing', total: 'missing', due_date: 'missing' });
  });

  it('scores zero for empty output', () => {
    expect(fieldF1Scorer('', expected, params).score).toBe(0);
  });

  it('scores zero when output JSON is an array instead of an object', () => {
    const record = fieldF1Scorer('[1, 2]', expected, params);
    expect(record.score).toBe(0);
    expect(record.details['reason']).toContain('not an object');
  });

  it('treats a wrong-typed field value as a mismatch, not a crash', () => {
    const output = '{"vendor": {"name": "Acme Corp"}, "total": 1234.5, "due_date": "2026-06-01"}';
    const record = fieldF1Scorer(output, expected, params);
    expect((record.details['fields'] as Record<string, string>)['vendor']).toBe('mismatch');
  });

  it('compares nested arrays and objects structurally when both sides are containers', () => {
    const deepExpected = { tags: ['a', 'b'], meta: { x: 1 } };
    const record = fieldF1Scorer(JSON.stringify(deepExpected), deepExpected, {
      key_fields: ['tags', 'meta'],
    });
    expect(record.pass).toBe(true);
  });

  it('does not match unicode lookalike values that NFKC cannot reconcile', () => {
    // Cyrillic "Асме" is not latin "Acme"; normalization must not paper over it.
    const output = '{"vendor": "Асме Corp", "total": 1234.5, "due_date": "2026-06-01"}';
    const record = fieldF1Scorer(output, expected, params);
    expect((record.details['fields'] as Record<string, string>)['vendor']).toBe('mismatch');
  });

  it('matches fullwidth digits in string fields via NFKC', () => {
    const output = '{"vendor": "Acme Corp", "total": "１２３４.５", "due_date": "2026-06-01"}';
    expect(fieldF1Scorer(output, expected, params).pass).toBe(true);
  });

  it('throws a task-authoring error when the expected value is not an object', () => {
    expect(() => fieldF1Scorer('{"a": 1}', 'not-an-object', params)).toThrow(
      /needs an object with the key fields as properties; fix the example file/,
    );
  });

  it('throws a task-authoring error when key_fields is missing', () => {
    expect(() => fieldF1Scorer('{}', expected, {})).toThrow(/key_fields/);
  });
});
