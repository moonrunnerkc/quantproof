import { describe, expect, it } from 'vitest';
import { jsonSchemaScorer } from '../../src/scoring/json-schema-scorer.js';

const schema = {
  type: 'object',
  required: ['vendor', 'total'],
  properties: {
    vendor: { type: 'string' },
    total: { type: 'number' },
  },
  additionalProperties: false,
};
const params = { schema };

describe('jsonSchemaScorer', () => {
  it('passes conforming JSON with score 1 and no violations', () => {
    const record = jsonSchemaScorer('{"vendor": "Acme", "total": 12.5}', undefined, params);
    expect(record).toEqual({
      score: 1,
      pass: true,
      details: { extractionNeeded: false, violations: [] },
    });
  });

  it('passes conforming JSON inside markdown fences and records that extraction was needed', () => {
    const record = jsonSchemaScorer('```json\n{"vendor": "Acme", "total": 1}\n```', undefined, params);
    expect(record.pass).toBe(true);
    expect(record.details['extractionNeeded']).toBe(true);
  });

  it('lists every violation, not just the first', () => {
    const record = jsonSchemaScorer('{"total": "twelve", "extra": true}', undefined, params);
    expect(record.score).toBe(0);
    const violations = record.details['violations'] as string[];
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.join('\n')).toContain('vendor');
    expect(violations.join('\n')).toContain('/total');
    expect(violations.join('\n')).toContain('additional');
  });

  it('scores zero for refusal prose with the parse failure in details', () => {
    const record = jsonSchemaScorer('I cannot produce JSON for this.', undefined, params);
    expect(record.score).toBe(0);
    expect(record.pass).toBe(false);
    expect((record.details['violations'] as string[])[0]).toContain('not JSON');
  });

  it('scores zero for empty output', () => {
    expect(jsonSchemaScorer('', undefined, params).pass).toBe(false);
  });

  it('scores zero for partial JSON', () => {
    const record = jsonSchemaScorer('{"vendor": "Acme", "total":', undefined, params);
    expect(record.pass).toBe(false);
    expect((record.details['violations'] as string[])[0]).toContain('not JSON');
  });

  it('scores zero when the JSON is the wrong type entirely', () => {
    const record = jsonSchemaScorer('[1, 2]', undefined, params);
    expect(record.score).toBe(0);
    expect((record.details['violations'] as string[]).join(' ')).toContain('object');
  });

  it('throws a task-authoring error when the schema param is missing', () => {
    expect(() => jsonSchemaScorer('{}', undefined, {})).toThrow(/scorer_params\.schema/);
  });
});
