import { describe, expect, it } from 'vitest';
import { renderComparison } from '../../src/report/comparison-table.js';
import { paretoFrontier } from '../../src/report/pareto.js';
import { recommend } from '../../src/report/recommend.js';
import { buildReportData } from '../../src/report/report-data.js';
import type { ReportData } from '../../src/report/report-data.js';
import type { CandidateAggregate } from '../../src/report/aggregate.js';
import { candidateResult, makeAggregate, runRecord, unitResult } from './report-fixtures.js';

function dataFor(aggregates: readonly CandidateAggregate[], notes: readonly string[] = []): ReportData {
  return {
    run: runRecord(),
    aggregates,
    pareto: paretoFrontier(aggregates),
    recommendation: recommend(aggregates),
    notes,
  };
}

describe('renderComparison', () => {
  it('renders one row per candidate with quality spread and vram delta inline', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('gemma3:4b', {
          quality: 0.833, vram: 4400, predictedPeakMib: 4000, tps: 10.4,
          summary: { scoreSpread: { min: 0.81, max: 0.85 } },
        }),
        makeAggregate('gemma3:1b', { quality: 0.7, vram: 1900, predictedPeakMib: 2000, tps: 25.2 }),
      ]),
    );
    expect(text).toContain('gemma3:4b');
    expect(text).toContain('0.833 (0.810..0.850)');
    expect(text).toContain('4400 (+10.0%)');
    expect(text).toContain('1900 (-5.0%)');
  });

  it('puts the recommendation on the bottom lines with runners-up', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('big', { quality: 0.9, vram: 8000 }),
        makeAggregate('small', { quality: 0.895, vram: 2000 }),
      ]),
    );
    const lines = text.trimEnd().split('\n');
    const recommendIndex = lines.findIndex((l) => l.startsWith('recommend small:'));
    const runnerUpIndex = lines.findIndex((l) => l.includes('runner-up big:'));
    expect(recommendIndex).toBeGreaterThan(0);
    expect(runnerUpIndex).toBeGreaterThan(recommendIndex);
  });

  it('renders flags inline and expands each one in the legend', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('clean', { quality: 0.9 }),
        makeAggregate('leaky', {
          quality: 0.6, gatesPassed: false, gateFailureCounts: { 'json-schema': 3 },
          offloadSuspectReason: 'measured peak plateaued under 60% of prediction',
        }),
      ]),
    );
    expect(text).toMatch(/leaky.*gates!,offload\?/);
    expect(text).toContain('gates! leaky: failed gate scorers: json-schema (3 units)');
    expect(text).toContain('offload? leaky: measured peak plateaued');
  });

  it('names the pareto frontier and the dominated candidates', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('front', { quality: 0.9, vram: 2000, tps: 50 }),
        makeAggregate('behind', { quality: 0.8, vram: 4000, tps: 20 }),
      ]),
    );
    expect(text).toContain('pareto frontier (quality/VRAM/tok/s): front');
    expect(text).toContain('dominated: behind');
  });

  it('says plainly when nothing passes gates, with nearest misses', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('a', { quality: 0.4, gatesPassed: false, gateFailureCounts: { regex: 2 } }),
      ]),
    );
    expect(text).toContain('pareto frontier: empty (no gate-passing candidates)');
    expect(text).toContain('no recommendation: no candidate passed all gate scorers');
    expect(text).toContain('nearest miss a:');
  });

  it('marks unmeasured vram as n/m and says why in the header', () => {
    const text = renderComparison({
      ...dataFor([makeAggregate('cpu-only', { vram: null })]),
      run: runRecord({
        gpuName: null, driverVersion: null, vramAvailable: false,
        vramUnavailableReason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
      }),
    });
    expect(text).toContain('VRAM not measured: nvidia-smi is not available');
    expect(text).toMatch(/cpu-only.*n\/m/);
  });

  it('marks an interrupted candidate and points at resume', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('done', { quality: 0.9 }),
        makeAggregate('cut-short', { quality: null, vram: null, tps: null, status: 'running' }),
      ]),
    );
    expect(text).toMatch(/cut-short.*incomplete/);
    expect(text).toContain('quantproof resume will complete its pending units');
  });

  it('renders notes under the header', () => {
    const text = renderComparison(dataFor([makeAggregate('m')], ['re-scored from raw outputs; 2 of 18 scores changed']));
    expect(text).toContain('note: re-scored from raw outputs; 2 of 18 scores changed');
  });

  it('stays within a normal terminal width for realistic rows', () => {
    const text = renderComparison(
      dataFor([
        makeAggregate('deepseek-r1:14b-qwen-distill-q4_K_M', {
          quality: 0.833, vram: 11800, predictedPeakMib: 11000, tps: 8.7,
          summary: { scoreSpread: { min: 0.81, max: 0.85 }, outputsDeterministic: false },
          offloadSuspectReason: 'median tok/s under 25% of the best similar-size candidate',
        }),
      ]),
    );
    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('buildReportData', () => {
  it('assembles aggregates, frontier, and recommendation from store views', () => {
    const data = buildReportData(
      runRecord(),
      [candidateResult('c1', 'gemma3:1b'), candidateResult('c2', 'gemma3:4b', { peakVramMib: 9000 })],
      [
        unitResult('001', 1, 1, { candidateId: 'c1' }),
        unitResult('001', 1, 0.9, { candidateId: 'c2' }),
      ],
    );
    expect(data.aggregates).toHaveLength(2);
    expect(data.pareto.frontier.map((p) => p.aggregate.candidate.modelName)).toContain('gemma3:1b');
    expect(data.recommendation.kind).toBe('recommended');
    if (data.recommendation.kind === 'recommended') {
      expect(data.recommendation.pick.candidate.modelName).toBe('gemma3:1b');
    }
  });
});
