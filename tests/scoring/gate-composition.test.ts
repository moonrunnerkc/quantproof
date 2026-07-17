import { describe, expect, it } from 'vitest';
import { scoreWithGates } from '../../src/scoring/gate-composition.js';
import type { BoundScorer } from '../../src/scoring/gate-composition.js';
import { fieldF1Scorer } from '../../src/scoring/field-f1-scorer.js';
import { jsonSchemaScorer } from '../../src/scoring/json-schema-scorer.js';

const schema = {
  type: 'object',
  required: ['vendor', 'total'],
  properties: { vendor: { type: 'string' }, total: { type: 'number' } },
};
const gate: BoundScorer = { name: 'json-schema', scorer: jsonSchemaScorer, params: { schema } };
const primary: BoundScorer = {
  name: 'field-f1',
  scorer: fieldF1Scorer,
  params: { key_fields: ['vendor', 'total'] },
};
const expected = { vendor: 'Acme', total: 10 };

describe('scoreWithGates', () => {
  it('returns the primary score when every gate passes', () => {
    const record = scoreWithGates('{"vendor": "Acme", "total": 10}', expected, primary, [gate]);
    expect(record.score).toBe(1);
    expect(record.pass).toBe(true);
    expect(record.details['failedGate']).toBeNull();
  });

  it('zeroes the result when a gate fails, even though fields partially match', () => {
    // total is a string: field-f1 alone would still score vendor+total via
    // normalization, but the schema gate rejects the type.
    const record = scoreWithGates('{"vendor": "Acme", "total": "10"}', expected, primary, [gate]);
    expect(record.score).toBe(0);
    expect(record.pass).toBe(false);
    expect(record.details['failedGate']).toBe('json-schema');
  });

  it('preserves the primary record in details when a gate zeroes the score', () => {
    const record = scoreWithGates('{"vendor": "Acme", "total": "10"}', expected, primary, [gate]);
    const primaryDetail = record.details['primary'] as { name: string; record: { score: number } };
    expect(primaryDetail.name).toBe('field-f1');
    expect(primaryDetail.record.score).toBe(1);
  });

  it('names the first failing gate when several gates fail', () => {
    const alwaysFailA: BoundScorer = {
      name: 'gate-a',
      scorer: () => ({ score: 0, pass: false, details: {} }),
      params: {},
    };
    const alwaysFailB: BoundScorer = {
      name: 'gate-b',
      scorer: () => ({ score: 0, pass: false, details: {} }),
      params: {},
    };
    const record = scoreWithGates('x', expected, primary, [alwaysFailA, alwaysFailB]);
    expect(record.details['failedGate']).toBe('gate-a');
  });

  it('behaves as the bare primary scorer when there are no gates', () => {
    const withGates = scoreWithGates('{"vendor": "Acme", "total": 10}', expected, primary, []);
    const bare = fieldF1Scorer('{"vendor": "Acme", "total": 10}', expected, primary.params);
    expect(withGates.score).toBe(bare.score);
    expect(withGates.pass).toBe(bare.pass);
  });

  it('fails overall when gates pass but the primary scorer fails', () => {
    const record = scoreWithGates('{"vendor": "Wrong", "total": 10}', expected, primary, [gate]);
    expect(record.details['failedGate']).toBeNull();
    expect(record.pass).toBe(false);
    expect(record.score).toBe(0.5);
  });

  it('records every gate result in details', () => {
    const record = scoreWithGates('{"vendor": "Acme", "total": 10}', expected, primary, [gate]);
    const gates = record.details['gates'] as { name: string; record: { pass: boolean } }[];
    expect(gates).toHaveLength(1);
    expect(gates[0]?.name).toBe('json-schema');
    expect(gates[0]?.record.pass).toBe(true);
  });
});
