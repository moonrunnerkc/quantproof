/**
 * Acceptance gate: every starter-pack example scores correctly against
 * a hand-computed expectation encoded in a test table. Perfect outputs
 * must score exactly 1 and pass on all 60 examples; the degraded tables
 * pin hand-computed partial scores and gate behavior.
 */

import { describe, expect, it } from 'vitest';
import { scoreWithGates } from '../../src/scoring/gate-composition.js';
import { loadStarterPack, perfectOutput } from '../helpers/starter-packs.js';

const ALL_IDS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(3, '0'));

describe('invoice-extraction expectations', () => {
  const { pack, primary, gates } = loadStarterPack('invoice-extraction');

  it('contains exactly examples 001 through 020', () => {
    expect(pack.examples.map((e) => e.id)).toEqual(ALL_IDS);
  });

  it.each(ALL_IDS)('example %s scores 1 and passes on a perfect output', (id) => {
    const example = pack.examples.find((e) => e.id === id);
    if (example === undefined) throw new Error(`missing example ${id}`);
    const record = scoreWithGates(
      perfectOutput('invoice-extraction', example.expected),
      example.expected,
      primary,
      gates,
    );
    expect(record.score).toBe(1);
    expect(record.pass).toBe(true);
    expect(record.details['failedGate']).toBeNull();
  });

  // Hand-computed degradations of example 001
  // (vendor "Northwind Traders Ltd.", total 4820.5, due_date "2026-06-01").
  const example001 = () => {
    const e = pack.examples[0];
    if (e === undefined || e.id !== '001') throw new Error('example 001 missing');
    return e;
  };

  it('001 with a wrong total scores 2/3: 2 TP, 1 FP, 1 FN over 3 key fields', () => {
    const output = JSON.stringify({
      vendor: 'Northwind Traders Ltd.',
      invoice_number: 'NW-2026-0142',
      total: 4999.99,
      due_date: '2026-06-01',
    });
    const record = scoreWithGates(output, example001().expected, primary, gates);
    expect(record.details['failedGate']).toBeNull();
    expect(record.score).toBe(2 / 3);
    expect(record.pass).toBe(false);
  });

  it('001 missing due_date is zeroed by the json-schema gate even though 2 of 3 fields match', () => {
    const output = JSON.stringify({
      vendor: 'Northwind Traders Ltd.',
      invoice_number: 'NW-2026-0142',
      total: 4820.5,
    });
    const record = scoreWithGates(output, example001().expected, primary, gates);
    expect(record.details['failedGate']).toBe('json-schema');
    expect(record.score).toBe(0);
    // Hand-computed underlying primary: 2 TP, 0 FP, 1 FN, f1 = 0.8.
    const primaryDetail = record.details['primary'] as { record: { score: number } };
    expect(primaryDetail.record.score).toBe(0.8);
  });

  it('001 in markdown fences still passes, with extraction flagged on the gate', () => {
    const output = '```json\n' + perfectOutput('invoice-extraction', example001().expected) + '\n```';
    const record = scoreWithGates(output, example001().expected, primary, gates);
    expect(record.score).toBe(1);
    const gateDetail = (record.details['gates'] as { record: { details: Record<string, unknown> } }[])[0];
    expect(gateDetail?.record.details['extractionNeeded']).toBe(true);
  });

  it('001 refusal prose scores 0 with the gate named', () => {
    const record = scoreWithGates('I cannot extract that.', example001().expected, primary, gates);
    expect(record.score).toBe(0);
    expect(record.details['failedGate']).toBe('json-schema');
  });
});

describe('ticket-classification expectations', () => {
  const { pack, primary, gates } = loadStarterPack('ticket-classification');

  // Hand-checked labels for all 20 tickets, in file order.
  const labels: readonly string[] = [
    'billing', 'bug', 'feature-request', 'account', 'other',
    'billing', 'bug', 'feature-request', 'account', 'other',
    'billing', 'bug', 'feature-request', 'account', 'other',
    'billing', 'bug', 'feature-request', 'account', 'other',
  ];

  it('contains exactly examples 001 through 020 with the hand-checked label cycle', () => {
    expect(pack.examples.map((e) => e.id)).toEqual(ALL_IDS);
    expect(pack.examples.map((e) => e.expected)).toEqual(labels);
  });

  it.each(ALL_IDS)('example %s scores 1 on the exact expected label', (id) => {
    const example = pack.examples.find((e) => e.id === id);
    if (example === undefined) throw new Error(`missing example ${id}`);
    const record = scoreWithGates(
      perfectOutput('ticket-classification', example.expected),
      example.expected,
      primary,
      gates,
    );
    expect(record).toMatchObject({ score: 1, pass: true });
  });

  it('a declared alias of the expected label scores 1 (defect resolves to bug)', () => {
    const bugExample = pack.examples[1];
    expect(bugExample?.expected).toBe('bug');
    const record = scoreWithGates('defect', 'bug', primary, gates);
    expect(record.score).toBe(1);
  });

  it('an uppercase padded label scores 1 through normalization', () => {
    expect(scoreWithGates('  BILLING\n', 'billing', primary, gates).score).toBe(1);
  });

  it('the wrong label scores 0', () => {
    expect(scoreWithGates('billing', 'bug', primary, gates).score).toBe(0);
  });

  it('a label wrapped in prose scores 0 and keeps the raw output', () => {
    const record = scoreWithGates('Category: bug', 'bug', primary, gates);
    expect(record.score).toBe(0);
    const primaryDetail = record.details['primary'] as { record: { details: Record<string, unknown> } };
    expect(primaryDetail.record.details['rawOutput']).toBe('Category: bug');
  });
});

describe('config-generation expectations', () => {
  const { pack, primary, gates } = loadStarterPack('config-generation');

  it('contains exactly examples 001 through 020', () => {
    expect(pack.examples.map((e) => e.id)).toEqual(ALL_IDS);
  });

  it.each(ALL_IDS)('example %s scores 1 and passes both pattern gate and schema', (id) => {
    const example = pack.examples.find((e) => e.id === id);
    if (example === undefined) throw new Error(`missing example ${id}`);
    const record = scoreWithGates(
      perfectOutput('config-generation', example.expected),
      example.expected,
      primary,
      gates,
    );
    expect(record.score).toBe(1);
    expect(record.pass).toBe(true);
    expect(record.details['failedGate']).toBeNull();
  });

  it('001 with port as a string is zeroed by the pattern gate', () => {
    // The pattern "port"\s*:\s*\d+ requires an unquoted number, so the
    // gate fails and names itself before the schema verdict matters.
    const output = '{"name": "payments-api", "port": "8080", "replicas": 3, "log_level": "info"}';
    const record = scoreWithGates(output, pack.examples[0]?.expected, primary, gates);
    expect(record.score).toBe(0);
    expect(record.details['failedGate']).toBe('pattern');
  });

  it('001 with an uppercase name fails the pattern gate', () => {
    const output = '{"name": "Payments-API", "port": 8080, "replicas": 3, "log_level": "info"}';
    const record = scoreWithGates(output, pack.examples[0]?.expected, primary, gates);
    expect(record.details['failedGate']).toBe('pattern');
    expect(record.score).toBe(0);
  });

  it('001 with an off-enum log level fails', () => {
    const output = '{"name": "payments-api", "port": 8080, "replicas": 3, "log_level": "verbose"}';
    const record = scoreWithGates(output, pack.examples[0]?.expected, primary, gates);
    expect(record.pass).toBe(false);
    expect(record.score).toBe(0);
  });

  it('001 in markdown fences still passes because patterns match inside the fence', () => {
    const output = '```json\n' + perfectOutput('config-generation', pack.examples[0]?.expected) + '\n```';
    const record = scoreWithGates(output, pack.examples[0]?.expected, primary, gates);
    expect(record.score).toBe(1);
  });
});
