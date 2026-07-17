import { describe, expect, it } from 'vitest';
import {
  aggregateCandidates,
  isGatePassing,
  median,
  summarizeRun,
} from '../../src/report/aggregate.js';
import { candidateResult, unitResult as unit } from './report-fixtures.js';

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

  it('computes latency medians and spreads over completed units only', () => {
    const summary = summarizeRun([
      unit('001', 1, 1, { ttftMs: 100, tps: 10 }),
      unit('002', 1, 1, { ttftMs: 300, tps: 30 }),
      unit('003', 1, 1, { ttftMs: 200, tps: 50 }),
      unit('004', 1, 0, { status: 'failed' }),
    ]);
    expect(summary.ttftMedianMs).toBe(200);
    expect(summary.ttftSpreadMs).toEqual({ min: 100, max: 300 });
    expect(summary.tokensPerSecondMedian).toBe(30);
    expect(summary.tokensPerSecondSpread).toEqual({ min: 10, max: 50 });
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

  it('counts units truncated at the token budget before any visible output', () => {
    const summary = summarizeRun([
      unit('001', 1, 0, { doneReason: 'length', output: '' }),
      unit('002', 1, 0, { doneReason: 'length', output: '  \n' }),
      unit('003', 1, 1, { doneReason: 'stop', output: 'label' }),
    ]);
    expect(summary.truncatedEmptyCount).toBe(2);
  });

  it('does not count truncation when the budget-limited output has content', () => {
    const summary = summarizeRun([unit('001', 1, 0.5, { doneReason: 'length', output: 'partial' })]);
    expect(summary.truncatedEmptyCount).toBe(0);
  });

  it('produces nulls, not zeros, when nothing completed', () => {
    const summary = summarizeRun([unit('001', 1, 0, { status: 'pending' })]);
    expect(summary.meanScore).toBeNull();
    expect(summary.passRate).toBeNull();
    expect(summary.scoreSpread).toBeNull();
    expect(summary.ttftMedianMs).toBeNull();
    expect(summary.ttftSpreadMs).toBeNull();
    expect(summary.tokensPerSecondSpread).toBeNull();
    expect(summary.pending).toBe(1);
  });
});

describe('aggregateCandidates', () => {
  it('groups units per candidate and keeps candidates in order', () => {
    const aggregates = aggregateCandidates(
      [candidateResult('c1', 'gemma3:4b'), candidateResult('c2', 'gemma3:1b')],
      [
        unit('001', 1, 1, { candidateId: 'c1' }),
        unit('001', 1, 0.5, { candidateId: 'c2' }),
      ],
    );
    expect(aggregates.map((a) => a.candidate.modelName)).toEqual(['gemma3:4b', 'gemma3:1b']);
    expect(aggregates[0]?.summary.meanScore).toBe(1);
    expect(aggregates[1]?.summary.meanScore).toBe(0.5);
  });

  it('computes the predicted versus measured vram delta in percent', () => {
    const [agg] = aggregateCandidates(
      [candidateResult('c1', 'gemma3:4b', { peakVramMib: 4400, record: { predictedPeakMib: 4000 } })],
      [unit('001', 1, 1, { candidateId: 'c1' })],
    );
    expect(agg?.vramDeltaPercent).toBeCloseTo(10, 10);
  });

  it('reports a null vram delta when either side is unmeasured', () => {
    const aggregates = aggregateCandidates(
      [
        candidateResult('c1', 'a', { peakVramMib: null }),
        candidateResult('c2', 'b', { record: { predictedPeakMib: null } }),
      ],
      [unit('001', 1, 1, { candidateId: 'c1' }), unit('001', 1, 1, { candidateId: 'c2' })],
    );
    expect(aggregates[0]?.vramDeltaPercent).toBeNull();
    expect(aggregates[1]?.vramDeltaPercent).toBeNull();
  });

  it('counts gate failures per gate and marks the candidate a gate-failer', () => {
    const [agg] = aggregateCandidates(
      [candidateResult('c1', 'gemma3:1b')],
      [
        unit('001', 1, 0, { candidateId: 'c1', failedGate: 'json-schema' }),
        unit('002', 1, 0, { candidateId: 'c1', failedGate: 'json-schema' }),
        unit('003', 1, 1, { candidateId: 'c1' }),
      ],
    );
    expect(agg?.gatesPassed).toBe(false);
    expect(agg?.gateFailureCounts).toEqual({ 'json-schema': 2 });
  });

  it('marks gates passed when every completed unit cleared every gate', () => {
    const [agg] = aggregateCandidates(
      [candidateResult('c1', 'gemma3:1b')],
      [unit('001', 1, 1, { candidateId: 'c1' }), unit('002', 1, 0.8, { candidateId: 'c1' })],
    );
    expect(agg?.gatesPassed).toBe(true);
    expect(agg?.gateFailureCounts).toEqual({});
  });

  it('leaves gate state null when nothing completed', () => {
    const [agg] = aggregateCandidates(
      [candidateResult('c1', 'big-model', { status: 'oom', peakVramMib: null })],
      [unit('001', 1, 0, { candidateId: 'c1', status: 'skipped' })],
    );
    expect(agg?.gatesPassed).toBeNull();
    expect(agg?.summary.meanScore).toBeNull();
  });
});

describe('isGatePassing', () => {
  const build = (
    status: 'completed' | 'oom',
    failedGate?: string,
  ): ReturnType<typeof aggregateCandidates>[number] => {
    const [agg] = aggregateCandidates(
      [candidateResult('c1', 'm', { status })],
      [unit('001', 1, failedGate === undefined ? 1 : 0, { candidateId: 'c1', ...(failedGate === undefined ? {} : { failedGate }) })],
    );
    if (agg === undefined) {
      throw new Error('aggregateCandidates returned nothing for a one-candidate input');
    }
    return agg;
  };

  it('accepts a completed candidate whose units all passed their gates', () => {
    expect(isGatePassing(build('completed'))).toBe(true);
  });

  it('rejects a candidate with any gate failure', () => {
    expect(isGatePassing(build('completed', 'json-schema'))).toBe(false);
  });

  it('rejects an oom candidate even when its completed units passed', () => {
    expect(isGatePassing(build('oom'))).toBe(false);
  });
});
