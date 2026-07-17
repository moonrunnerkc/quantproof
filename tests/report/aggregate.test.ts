import { describe, expect, it } from 'vitest';
import { median, summarizeRun } from '../../src/report/aggregate.js';
import type { UnitResult } from '../../src/results/record-types.js';

function unit(
  exampleId: string,
  repetition: number,
  score: number,
  overrides: { output?: string; ttftMs?: number | null; tps?: number | null; status?: 'completed' | 'failed' | 'pending' } = {},
): UnitResult {
  const status = overrides.status ?? 'completed';
  const id = `${exampleId}-${String(repetition)}`;
  if (status !== 'completed') {
    return {
      unit: { id, runId: 'r', candidateId: 'c', exampleId, repetition },
      status,
      failureReason: status === 'failed' ? 'boom' : null,
      generation: null,
      score: null,
    };
  }
  return {
    unit: { id, runId: 'r', candidateId: 'c', exampleId, repetition },
    status,
    failureReason: null,
    generation: {
      id: `g-${id}`, workUnitId: id, output: overrides.output ?? `out-${exampleId}`,
      doneReason: 'stop', ttftMs: overrides.ttftMs ?? 100, tokensPerSecond: overrides.tps ?? 40,
      wallMs: 500, tokenCount: 10, promptTokenCount: 20, outputTokenCount: 10, requestOptions: {},
    },
    score: { id: `s-${id}`, workUnitId: id, scorerName: 'field-f1', score, pass: score === 1, details: {} },
  };
}

describe('median', () => {
  it('returns the middle value for odd counts', () => {
    expect(median([9, 1, 5])).toBe(5);
  });
  it('averages the middle pair for even counts', () => {
    expect(median([1, 2, 10, 20])).toBe(6);
  });
  it('returns null for an empty list', () => {
    expect(median([])).toBeNull();
  });
});

describe('summarizeRun', () => {
  it('aggregates quality per repetition and reports the spread', () => {
    const summary = summarizeRun([
      unit('001', 1, 1), unit('002', 1, 1),      // rep 1 mean 1.0
      unit('001', 2, 1), unit('002', 2, 0.5),    // rep 2 mean 0.75
    ]);
    expect(summary.meanScore).toBe(0.875);
    expect(summary.repetitions).toEqual([
      { repetition: 1, meanScore: 1 },
      { repetition: 2, meanScore: 0.75 },
    ]);
    expect(summary.scoreSpread).toEqual({ min: 0.75, max: 1 });
    expect(summary.passRate).toBe(0.75);
  });

  it('computes latency medians over completed units only', () => {
    const summary = summarizeRun([
      unit('001', 1, 1, { ttftMs: 100, tps: 10 }),
      unit('002', 1, 1, { ttftMs: 300, tps: 30 }),
      unit('003', 1, 1, { ttftMs: 200, tps: 50 }),
      unit('004', 1, 0, { status: 'failed' }),
    ]);
    expect(summary.ttftMedianMs).toBe(200);
    expect(summary.tokensPerSecondMedian).toBe(30);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(1);
  });

  it('flags byte-identical outputs across repetitions as deterministic', () => {
    const summary = summarizeRun([
      unit('001', 1, 1, { output: 'same' }),
      unit('001', 2, 1, { output: 'same' }),
    ]);
    expect(summary.outputsDeterministic).toBe(true);
  });

  it('flags any per-example output difference as nondeterministic', () => {
    const summary = summarizeRun([
      unit('001', 1, 1, { output: 'same' }),
      unit('001', 2, 1, { output: 'same ' }),
    ]);
    expect(summary.outputsDeterministic).toBe(false);
  });

  it('leaves determinism unchecked when nothing ran more than once', () => {
    expect(summarizeRun([unit('001', 1, 1)]).outputsDeterministic).toBeNull();
  });

  it('produces nulls, not zeros, when nothing completed', () => {
    const summary = summarizeRun([unit('001', 1, 0, { status: 'pending' })]);
    expect(summary.meanScore).toBeNull();
    expect(summary.passRate).toBeNull();
    expect(summary.scoreSpread).toBeNull();
    expect(summary.ttftMedianMs).toBeNull();
    expect(summary.pending).toBe(1);
  });
});
