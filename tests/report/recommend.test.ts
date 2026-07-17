import { describe, expect, it } from 'vitest';
import { recommend } from '../../src/report/recommend.js';
import { makeAggregate } from './report-fixtures.js';

function pickOf(result: ReturnType<typeof recommend>): string {
  if (result.kind !== 'recommended') {
    throw new Error(`expected a recommendation, got kind "${result.kind}": ${result.reason}`);
  }
  return result.pick.candidate.modelName;
}

describe('recommend', () => {
  describe('tolerance edges (table-driven)', () => {
    // Best quality is 1.0 at 8000 MiB; the small candidate sits at 2000 MiB.
    const cases: readonly {
      readonly name: string;
      readonly smallQuality: number;
      readonly tolerance: number | undefined;
      readonly expected: string;
    }[] = [
      { name: 'well inside the default 2%', smallQuality: 0.995, tolerance: undefined, expected: 'small' },
      { name: 'exactly on the threshold counts as within', smallQuality: 0.98, tolerance: undefined, expected: 'small' },
      { name: 'just below the threshold loses', smallQuality: 0.9799, tolerance: undefined, expected: 'big' },
      { name: 'zero tolerance demands the best quality', smallQuality: 0.9999, tolerance: 0, expected: 'big' },
      { name: 'a wide tolerance admits a weak candidate', smallQuality: 0.8, tolerance: 0.25, expected: 'small' },
      { name: 'a wide tolerance still has a floor', smallQuality: 0.74, tolerance: 0.25, expected: 'big' },
    ];

    for (const { name, smallQuality, tolerance, expected } of cases) {
      it(name, () => {
        const result = recommend(
          [
            makeAggregate('big', { quality: 1, vram: 8000 }),
            makeAggregate('small', { quality: smallQuality, vram: 2000 }),
          ],
          tolerance === undefined ? {} : { qualityTolerance: tolerance },
        );
        expect(pickOf(result)).toBe(expected);
      });
    }
  });

  it('recommends the best-quality candidate when it is also the smallest', () => {
    const result = recommend([
      makeAggregate('lean', { quality: 0.95, vram: 2000 }),
      makeAggregate('bulky', { quality: 0.9, vram: 9000 }),
    ]);
    expect(pickOf(result)).toBe('lean');
    if (result.kind === 'recommended') {
      expect(result.reason).toContain('best measured quality (0.950)');
      expect(result.reason).toContain('2000 MiB');
    }
  });

  it('cites both quality numbers and both footprints when trading quality for vram', () => {
    const result = recommend([
      makeAggregate('big', { quality: 1, vram: 8000 }),
      makeAggregate('small', { quality: 0.99, vram: 2000 }),
    ]);
    expect(pickOf(result)).toBe('small');
    if (result.kind === 'recommended') {
      expect(result.reason).toContain('0.990');
      expect(result.reason).toContain('1.000');
      expect(result.reason).toContain('2000 MiB');
      expect(result.reason).toContain('8000 MiB');
    }
  });

  it('breaks vram ties by quality, then throughput', () => {
    const byQuality = recommend([
      makeAggregate('tie-lo', { quality: 0.99, vram: 2000 }),
      makeAggregate('tie-hi', { quality: 1, vram: 2000 }),
    ]);
    expect(pickOf(byQuality)).toBe('tie-hi');

    const byRate = recommend([
      makeAggregate('slow', { quality: 1, vram: 2000, tps: 20 }),
      makeAggregate('fast', { quality: 1, vram: 2000, tps: 60 }),
    ]);
    expect(pickOf(byRate)).toBe('fast');
  });

  it('falls back to weights when any within-tolerance candidate lacks a vram measurement', () => {
    const result = recommend([
      makeAggregate('unmeasured-small', { quality: 1, vram: null, sizeBytes: 500 * 1024 * 1024 }),
      makeAggregate('measured-big', { quality: 1, vram: 3000, sizeBytes: 4000 * 1024 * 1024 }),
    ]);
    expect(pickOf(result)).toBe('unmeasured-small');
    if (result.kind === 'recommended') {
      expect(result.reason).toContain('weights on disk');
      expect(result.reason).toContain('peak VRAM was not measured');
    }
  });

  it('explains every runner-up: quality drop, vram cost, and oom', () => {
    const result = recommend([
      makeAggregate('picked', { quality: 1, vram: 2000 }),
      makeAggregate('costly', { quality: 1, vram: 6000 }),
      makeAggregate('weak', { quality: 0.5, vram: 1000 }),
      makeAggregate('exploded', {
        quality: null, vram: null, tps: null, status: 'oom',
        statusReason: 'oom-suspect during load at context 8192',
      }),
    ]);
    expect(pickOf(result)).toBe('picked');
    if (result.kind === 'recommended') {
      const reasons = new Map(result.runnersUp.map((r) => [r.aggregate.candidate.modelName, r.reason]));
      expect(reasons.get('costly')).toContain('4000 MiB more peak VRAM');
      expect(reasons.get('weak')).toContain('50.0% below the best');
      expect(reasons.get('exploded')).toContain('oom-suspect during load');
    }
  });

  it('says plainly when nothing passes gates and lists nearest misses best first', () => {
    const result = recommend([
      makeAggregate('closer', { quality: 0.7, gatesPassed: false, gateFailureCounts: { 'json-schema': 1 } }),
      makeAggregate('further', { quality: 0.3, gatesPassed: false, gateFailureCounts: { 'json-schema': 5 } }),
    ]);
    expect(result.kind).toBe('none');
    if (result.kind === 'none') {
      expect(result.reason).toContain('no candidate passed all gate scorers');
      expect(result.nearestMisses.map((m) => m.aggregate.candidate.modelName)).toEqual(['closer', 'further']);
      expect(result.nearestMisses[0]?.reason).toContain('json-schema (1 unit)');
    }
  });

  it('handles an empty candidate list without inventing a recommendation', () => {
    const result = recommend([]);
    expect(result.kind).toBe('none');
    if (result.kind === 'none') {
      expect(result.reason).toBe('no candidates were evaluated');
    }
  });

  it('rejects a tolerance outside [0, 1) with a fix hint', () => {
    expect(() => recommend([makeAggregate('a')], { qualityTolerance: 2 })).toThrow(/pass 0\.02 for a 2% tolerance/);
  });
});
