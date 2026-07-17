import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../src/results/run-store.js';
import type { GenerationRecord, RunRecord, UnitScoreRecord } from '../../src/results/record-types.js';

let dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quantproof-store-'));
  dirs.push(dir);
  return join(dir, 'nested', 'results.db');
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const run: RunRecord = {
  id: 'run-1',
  createdAtMs: 1750000000000,
  packName: 'invoice-extraction',
  packDir: '/packs/invoice-extraction',
  taskType: 'extraction',
  scorerName: 'field-f1',
  generation: { context: 4096, max_tokens: 512, temperature: 0, seed: 42, runs_per_example: 3 },
  backendVersion: 'ollama 0.23.1',
  gpuName: null,
  driverVersion: null,
  vramAvailable: false,
  vramUnavailableReason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
};

function seedPlan(store: RunStore): void {
  store.createRun(run);
  store.createCandidate({
    id: 'cand-1', runId: 'run-1', modelName: 'gemma3:1b',
    digest: 'abc123', quantization: 'Q4_K_M', parameterSize: '999.89M', sizeBytes: 815319791,
  });
  store.createWorkUnits([
    { id: 'unit-1', runId: 'run-1', candidateId: 'cand-1', exampleId: '001', repetition: 1 },
    { id: 'unit-2', runId: 'run-1', candidateId: 'cand-1', exampleId: '001', repetition: 2 },
    { id: 'unit-3', runId: 'run-1', candidateId: 'cand-1', exampleId: '002', repetition: 1 },
  ]);
}

const generation = (unitId: string): GenerationRecord => ({
  id: `gen-${unitId}`, workUnitId: unitId,
  output: '{"vendor": "Acme", "total": 12.5}', doneReason: 'stop',
  ttftMs: 231.5, tokensPerSecond: 42.7, wallMs: 900.1, tokenCount: 12,
  promptTokenCount: 180, outputTokenCount: 12,
  requestOptions: { model: 'gemma3:1b', options: { temperature: 0, seed: 42, num_predict: 512, num_ctx: 4096 } },
});

const score = (unitId: string): UnitScoreRecord => ({
  id: `score-${unitId}`, workUnitId: unitId, scorerName: 'field-f1',
  score: 1, pass: true, details: { failedGate: null },
});

describe('RunStore', () => {
  it('journals a completed unit and reads it back joined with generation and score', () => {
    const store = RunStore.open(tempDb());
    seedPlan(store);
    store.completeWorkUnit(generation('unit-1'), score('unit-1'));
    const results = store.listUnitResults('run-1');
    expect(results).toHaveLength(3);
    const done = results.find((r) => r.unit.id === 'unit-1');
    expect(done?.status).toBe('completed');
    expect(done?.generation?.output).toBe('{"vendor": "Acme", "total": 12.5}');
    expect(done?.generation?.requestOptions).toEqual(generation('unit-1').requestOptions);
    expect(done?.score?.score).toBe(1);
    expect(done?.score?.pass).toBe(true);
    store.close();
  });

  it('keeps completed units readable after the process "dies" (reopen from disk)', () => {
    const dbPath = tempDb();
    const store = RunStore.open(dbPath);
    seedPlan(store);
    store.completeWorkUnit(generation('unit-1'), score('unit-1'));
    store.completeWorkUnit(generation('unit-2'), score('unit-2'));
    // No close(): simulate a hard death. WAL must still surface both units.
    const reopened = RunStore.open(dbPath);
    const results = reopened.listUnitResults('run-1');
    expect(results.filter((r) => r.status === 'completed')).toHaveLength(2);
    expect(results.find((r) => r.unit.id === 'unit-3')?.status).toBe('pending');
    reopened.close();
    store.close();
  });

  it('journals each unit in its own transaction: a failed insert leaves the unit pending', () => {
    const store = RunStore.open(tempDb());
    seedPlan(store);
    store.completeWorkUnit(generation('unit-1'), score('unit-1'));
    // Duplicate generation id violates the primary key mid-transaction.
    expect(() =>
      store.completeWorkUnit({ ...generation('unit-2'), id: 'gen-unit-1' }, score('unit-2')),
    ).toThrow();
    const results = store.listUnitResults('run-1');
    expect(results.find((r) => r.unit.id === 'unit-2')?.status).toBe('pending');
    expect(results.find((r) => r.unit.id === 'unit-2')?.score).toBeNull();
    store.close();
  });

  it('records failed units with their reason', () => {
    const store = RunStore.open(tempDb());
    seedPlan(store);
    store.failWorkUnit('unit-3', 'backend crashed mid-generation');
    const failed = store.listUnitResults('run-1').find((r) => r.unit.id === 'unit-3');
    expect(failed?.status).toBe('failed');
    expect(failed?.failureReason).toBe('backend crashed mid-generation');
    store.close();
  });

  it('stores candidate outcomes including the nondeterminism flag', () => {
    const dbPath = tempDb();
    const store = RunStore.open(dbPath);
    seedPlan(store);
    store.finishCandidate('cand-1', {
      status: 'completed',
      peakVramMib: 4212,
      vramSamples: [[0, 900], [200, 4212]],
      deterministic: false,
    });
    store.close();
    const reopened = RunStore.open(dbPath);
    expect(reopened.listUnitResults('run-1')).toHaveLength(3);
    reopened.close();
  });

  it('preserves full raw output byte for byte, fences and unicode included', () => {
    const store = RunStore.open(tempDb());
    seedPlan(store);
    const rawOutput = '```json\n{"vendor": "Acmé Ltd", "total": 12.5}\n```\nHope that helps! ４２';
    store.completeWorkUnit({ ...generation('unit-1'), output: rawOutput }, score('unit-1'));
    const readBack = store.listUnitResults('run-1').find((r) => r.unit.id === 'unit-1');
    expect(readBack?.generation?.output).toBe(rawOutput);
    store.close();
  });
});
