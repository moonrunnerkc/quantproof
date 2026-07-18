import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMarkdownReport, reproductionCommand } from '../../src/report/markdown-report.js';
import { paretoFrontier } from '../../src/report/pareto.js';
import { recommend } from '../../src/report/recommend.js';
import type { ReportData } from '../../src/report/report-data.js';
import { makeAggregate, runRecord } from './report-fixtures.js';

const goldenPath = fileURLToPath(new URL('./fixtures/markdown-report.golden.md', import.meta.url));

/**
 * A sweep with every interesting shape: a best-quality large model, a
 * near-tie small model that should win the recommendation, a gate
 * failer, an OOM candidate, and an offload suspect.
 */
function caseStudyData(): ReportData {
  const aggregates = [
    makeAggregate('qwen3:14b', {
      quality: 0.917, vram: 10190, predictedPeakMib: 10000, tps: 10.4,
      sizeBytes: 9_276_124_602, parameterSize: '14.8B',
      summary: {
        scoreSpread: { min: 0.9, max: 0.93 },
        ttftMedianMs: 640, ttftSpreadMs: { min: 512, max: 811 },
        tokensPerSecondSpread: { min: 9.8, max: 11.2 },
      },
    }),
    makeAggregate('gemma3:4b', {
      quality: 0.905, vram: 4212, predictedPeakMib: 4000, tps: 25.2,
      sizeBytes: 3_338_801_804, parameterSize: '4.3B',
      summary: {
        scoreSpread: { min: 0.9, max: 0.91 },
        ttftMedianMs: 231, ttftSpreadMs: { min: 198, max: 268 },
        tokensPerSecondSpread: { min: 24.1, max: 26 },
      },
    }),
    makeAggregate('gemma3:1b', {
      quality: 0.31, vram: 1854, predictedPeakMib: 1900, tps: 41.7,
      sizeBytes: 815_319_791, parameterSize: '999.89M',
      gatesPassed: false, gateFailureCounts: { 'json-schema': 4 },
      passRate: 0.31,
      summary: { scoreSpread: { min: 0.29, max: 0.33 } },
    }),
    makeAggregate('gemma3-27b-q4:latest', {
      quality: null, vram: null, tps: null, status: 'oom',
      statusReason: 'oom-suspect during load/warmup at context 4096: model failed to load',
      sizeBytes: 17_600_000_000, parameterSize: '27.4B', predictedPeakMib: 18447,
    }),
    makeAggregate('qwen3:8b-split', {
      quality: 0.899, vram: 5100, predictedPeakMib: 9000, tps: 3.1,
      sizeBytes: 5_200_000_000, parameterSize: '8.2B',
      offloadSuspectReason:
        'measured peak 5100 MiB is under 60% of the predicted 9000 MiB while completing; throughput also trails similar-size candidates',
      summary: { scoreSpread: { min: 0.89, max: 0.91 } },
    }),
  ];
  return {
    run: runRecord(),
    aggregates,
    pareto: paretoFrontier(aggregates),
    recommendation: recommend(aggregates),
    notes: [],
  };
}

describe('renderMarkdownReport', () => {
  it('matches the reviewed golden file byte for byte', () => {
    const rendered = renderMarkdownReport(caseStudyData());
    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, rendered);
    }
    expect(rendered).toBe(readFileSync(goldenPath, 'utf8'));
  });

  it('contains every required section in build-plan order', () => {
    const rendered = renderMarkdownReport(caseStudyData());
    const sections = ['## Environment', '## Results', '## Pareto frontier', '## Recommendation', '## Methodology', '## Reproduce'];
    const positions = sections.map((s) => rendered.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('never emits an em dash or en dash anywhere', () => {
    expect(renderMarkdownReport(caseStudyData())).not.toMatch(/[\u2013\u2014]/);
  });

  it('footnotes empty-output truncation with the count and the fix', () => {
    const truncated = makeAggregate('thinker:e4b', {
      quality: 0, passRate: 0,
      summary: { truncatedEmptyCount: 6 },
    });
    const rendered = renderMarkdownReport({
      run: runRecord(),
      aggregates: [truncated],
      pareto: paretoFrontier([truncated]),
      recommendation: recommend([truncated]),
      notes: [],
    });
    expect(rendered).toContain('thinker:e4b: 6 of 6 completed units hit the max_tokens budget before emitting any visible output');
    expect(rendered).toContain('raise generation.max_tokens in task.yaml');
  });

  it('links the methodology doc and prints the exact reproduction command', () => {
    const rendered = renderMarkdownReport(caseStudyData());
    expect(rendered).toContain('[docs/methodology.md](docs/methodology.md)');
    expect(rendered).toContain('quantproof run --pack ./examples/invoice-extraction');
  });

  it('renders an unmeasured-vram run honestly in title, environment, and table', () => {
    const data = caseStudyData();
    const rendered = renderMarkdownReport({
      ...data,
      run: runRecord({
        gpuName: null, driverVersion: null, vramAvailable: false,
        vramUnavailableReason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
      }),
      aggregates: [makeAggregate('cpu-model', { vram: null })],
      pareto: paretoFrontier([makeAggregate('cpu-model', { vram: null })]),
      recommendation: recommend([makeAggregate('cpu-model', { vram: null })]),
    });
    expect(rendered).toContain('CPU (no GPU telemetry)');
    expect(rendered).toContain('not measured (nvidia-smi is not available');
    expect(rendered).toContain('| not measured |');
  });

  it('labels a system-RAM run as CPU inference in the methodology', () => {
    const data = caseStudyData();
    const rendered = renderMarkdownReport({
      ...data,
      run: runRecord({ gpuName: 'system RAM', driverVersion: 'kernel 6.17.0-test' }),
    });
    expect(rendered).toContain('resident backend process memory against system RAM, CPU inference');
    expect(rendered).toContain('system RAM, driver kernel 6.17.0-test');
  });

  it('footnotes an interrupted candidate and points at resume', () => {
    const data = caseStudyData();
    const interrupted = makeAggregate('half-done', { quality: null, vram: null, tps: null, status: 'running' });
    const rendered = renderMarkdownReport({ ...data, aggregates: [...data.aggregates, interrupted] });
    expect(rendered).toContain('half-done: interrupted before finishing; quantproof resume');
  });

  it('renders re-score notes as a leading blockquote', () => {
    const data = { ...caseStudyData(), notes: ['re-scored from raw outputs with current scorers; 3 of 90 scores changed'] };
    expect(renderMarkdownReport(data)).toContain('> Note: re-scored from raw outputs');
  });
});

describe('reproductionCommand', () => {
  it('rebuilds the plain sweep invocation', () => {
    expect(reproductionCommand(runRecord())).toBe('quantproof run --pack ./examples/invoice-extraction');
  });

  it('carries model, config, limit, and force back out of the plan snapshot', () => {
    const run = runRecord({
      plan: {
        explicitModel: null, configPath: 'sweep.yaml', configFingerprint: 'x',
        packFingerprint: 'pack-fp', limit: 5, force: true,
      },
    });
    expect(reproductionCommand(run)).toBe(
      'quantproof run --pack ./examples/invoice-extraction --config sweep.yaml --limit 5 --force',
    );
  });

  it('treats a named model as its own force override', () => {
    const run = runRecord({
      plan: {
        explicitModel: 'gemma3:1b', configPath: null, configFingerprint: null,
        packFingerprint: 'pack-fp', limit: null, force: true,
      },
    });
    expect(reproductionCommand(run)).toBe(
      'quantproof run --pack ./examples/invoice-extraction --model gemma3:1b',
    );
  });
});
