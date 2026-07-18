import { describe, expect, it } from 'vitest';
import { renderTerminalReport } from '../../src/report/terminal-report.js';
import type { ReportInput } from '../../src/report/terminal-report.js';
import type { RunSummary } from '../../src/report/aggregate.js';

const summary: RunSummary = {
  completed: 60, failed: 0, pending: 0, skipped: 0,
  meanScore: 0.943, passRate: 0.9,
  repetitions: [
    { repetition: 1, meanScore: 0.95 },
    { repetition: 2, meanScore: 0.93 },
    { repetition: 3, meanScore: 0.95 },
  ],
  scoreSpread: { min: 0.93, max: 0.95 },
  ttftMedianMs: 231.4, ttftSpreadMs: { min: 198.2, max: 267.9 },
  tokensPerSecondMedian: 42.7, tokensPerSecondSpread: { min: 40.1, max: 44.9 },
  wallMsTotal: 60000,
  outputsDeterministic: true,
  truncatedEmptyCount: 0,
};

const base: ReportInput = {
  run: {
    id: 'r', createdAtMs: 0, packName: 'invoice-extraction', packDir: './examples/invoice-extraction',
    taskType: 'extraction', scorerName: 'field-f1',
    generation: { context: 4096, max_tokens: 512, temperature: 0, seed: 42, runs_per_example: 3 },
    backendVersion: 'ollama 0.23.1', gpuName: 'NVIDIA GeForce RTX 5070', driverVersion: '580.65.06',
    vramAvailable: true, vramUnavailableReason: null, packProvenance: null,
    plan: {
      explicitModel: null, configPath: null, configFingerprint: null,
      packFingerprint: 'f', limit: null, force: false,
    },
  },
  candidate: {
    id: 'c', runId: 'r', modelName: 'gemma3:1b', digest: 'a2af6cc3eb7fa8be85',
    quantization: 'Q4_K_M', parameterSize: '999.89M', sizeBytes: 815319791,
    fitVerdict: 'fits', predictedPeakMib: 4000, fitDetails: {},
  },
  status: 'completed',
  statusReason: null,
  offloadSuspectReason: null,
  summary,
  vram: {
    available: true,
    gpu: { name: 'NVIDIA GeForce RTX 5070', driverVersion: '580.65.06', totalMib: 12227 },
    peakMib: 4212,
    samples: [{ at: 0, usedMib: 900 }, { at: 200, usedMib: 4212 }],
  },
};

describe('renderTerminalReport', () => {
  it('renders quality with its repetition spread', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('0.943');
    expect(text).toContain('rep spread 0.930 to 0.950');
  });

  it('renders latency medians and predicted versus measured peak vram', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('231 ms');
    expect(text).toContain('42.7');
    // (4212 - 4000) / 4000 = +5.3%.
    expect(text).toContain('4212 MiB peak measured (predicted 4000 MiB, delta 5.3%)');
  });

  it('renders the fit prediction verdict', () => {
    expect(renderTerminalReport(base)).toContain('fits, predicted peak 4000 MiB');
  });

  it('renders the environment line with digest, backend, gpu, and driver', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('ollama 0.23.1');
    expect(text).toContain('gemma3:1b@a2af6cc3eb7f');
    expect(text).toContain('NVIDIA GeForce RTX 5070 (driver 580.65.06)');
  });

  it('renders a reproduction command carrying seed and context', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('repro: quantproof run --pack ./examples/invoice-extraction');
    expect(text).toContain('seed 42');
  });

  it('renders an oom candidate as a result, not an error', () => {
    const text = renderTerminalReport({
      ...base,
      status: 'oom',
      statusReason: 'oom-suspect during load at context 4096: model failed to load',
      summary: { ...summary, completed: 0, skipped: 60, meanScore: null, scoreSpread: null, passRate: null },
    });
    expect(text).toContain('OOM at context 4096 (a result, not an error)');
    expect(text).toContain('oom-suspect during load');
    expect(text).toContain('60 skipped');
  });

  it('renders a suspected cpu/gpu split loudly with its reasoning', () => {
    const text = renderTerminalReport({
      ...base,
      offloadSuspectReason: 'measured peak 2500 MiB plateaued under 60% of the predicted 5000 MiB',
    });
    expect(text).toContain('SUSPECTED CPU/GPU SPLIT');
    expect(text).toContain('plateaued');
  });

  it('renders unmeasured vram loudly with the reason, never as a bare n/a', () => {
    const text = renderTerminalReport({
      ...base,
      vram: { available: false, reason: 'nvidia-smi is not available on this machine, so VRAM was not measured' },
    });
    expect(text).toContain('NOT MEASURED');
    expect(text).toContain('nvidia-smi is not available');
  });

  it('renders nondeterminism loudly when outputs differ despite the seed', () => {
    const text = renderTerminalReport({
      ...base,
      summary: { ...summary, outputsDeterministic: false },
    });
    expect(text).toContain('NONDETERMINISTIC');
  });

  it('renders empty-output truncation loudly with the budget and the fix', () => {
    const text = renderTerminalReport({
      ...base,
      summary: { ...summary, truncatedEmptyCount: 60 },
    });
    expect(text).toContain('TRUNCATED BEFORE CONTENT: 60 of 60 units stopped at max_tokens 512');
    expect(text).toContain('raise generation.max_tokens in task.yaml');
  });

  it('says plainly when nothing completed', () => {
    const text = renderTerminalReport({
      ...base,
      status: 'failed',
      statusReason: 'no unit completed',
      summary: { ...summary, meanScore: null, scoreSpread: null, completed: 0, failed: 60, passRate: null },
    });
    expect(text).toContain('FAILED: no unit completed');
    expect(text).toContain('no completed generations');
  });
});
