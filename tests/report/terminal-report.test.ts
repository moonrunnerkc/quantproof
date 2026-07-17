import { describe, expect, it } from 'vitest';
import { renderTerminalReport } from '../../src/report/terminal-report.js';
import type { ReportInput } from '../../src/report/terminal-report.js';
import type { RunSummary } from '../../src/report/aggregate.js';

const summary: RunSummary = {
  completed: 60, failed: 0, pending: 0,
  meanScore: 0.943, passRate: 0.9,
  repetitions: [
    { repetition: 1, meanScore: 0.95 },
    { repetition: 2, meanScore: 0.93 },
    { repetition: 3, meanScore: 0.95 },
  ],
  scoreSpread: { min: 0.93, max: 0.95 },
  ttftMedianMs: 231.4, tokensPerSecondMedian: 42.7, wallMsTotal: 60000,
  outputsDeterministic: true,
};

const base: ReportInput = {
  run: {
    id: 'r', createdAtMs: 0, packName: 'invoice-extraction', packDir: './examples/invoice-extraction',
    taskType: 'extraction', scorerName: 'field-f1',
    generation: { context: 4096, max_tokens: 512, temperature: 0, seed: 42, runs_per_example: 3 },
    backendVersion: 'ollama 0.23.1', gpuName: 'NVIDIA GeForce RTX 5070', driverVersion: '580.65.06',
    vramAvailable: true, vramUnavailableReason: null,
  },
  candidate: {
    id: 'c', runId: 'r', modelName: 'gemma3:1b', digest: 'a2af6cc3eb7fa8be85',
    quantization: 'Q4_K_M', parameterSize: '999.89M', sizeBytes: 815319791,
  },
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

  it('renders latency medians and peak vram', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('231 ms');
    expect(text).toContain('42.7');
    expect(text).toContain('4212 MiB peak');
  });

  it('renders the environment line with digest, backend, gpu, and driver', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('ollama 0.23.1');
    expect(text).toContain('gemma3:1b@a2af6cc3eb7f');
    expect(text).toContain('NVIDIA GeForce RTX 5070 (driver 580.65.06)');
  });

  it('renders a reproduction command carrying seed and context', () => {
    const text = renderTerminalReport(base);
    expect(text).toContain('quantproof run --pack ./examples/invoice-extraction --model gemma3:1b');
    expect(text).toContain('seed 42');
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

  it('says when determinism was not checkable', () => {
    const text = renderTerminalReport({
      ...base,
      summary: { ...summary, outputsDeterministic: null },
    });
    expect(text).toContain('not checked (single repetition)');
  });

  it('says plainly when nothing completed', () => {
    const text = renderTerminalReport({
      ...base,
      summary: { ...summary, meanScore: null, scoreSpread: null, completed: 0, failed: 6, passRate: null },
    });
    expect(text).toContain('no completed generations');
  });
});
