import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../src/results/run-store.js';
import type { CandidateRecord, GenerationRecord, RunRecord, UnitScoreRecord } from '../../src/results/record-types.js';

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
  packProvenance: null,
  plan: {
    explicitModel: null,
    configPath: '/cfg/quantproof.yaml',
    configFingerprint: 'c0ffee',
    packFingerprint: 'deadbeef',
    limit: 2,
    force: false,
  },
};

const candidate: CandidateRecord = {
  id: 'cand-1', runId: 'run-1', modelName: 'gemma3:1b',
  digest: 'abc123', quantization: 'Q4_K_M', parameterSize: '999.89M', sizeBytes: 815319791,
  fitVerdict: 'unknown', predictedPeakMib: 1853.55, fitDetails: { weightsMib: 777.55 },
};

function seedPlan(store: RunStore): void {
  store.createRun(run);
  store.createCandidate(candidate);
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
  it('lists runs newest first with generation params and plan snapshot rehydrated', () => {
    const store = RunStore.open(tempDb());
    store.createRun(run);
    store.createRun({ ...run, id: 'run-2', createdAtMs: run.createdAtMs + 1000 });
    const runs = store.listRuns();
    expect(runs.map((r) => r.id)).toEqual(['run-2', 'run-1']);
    expect(runs[1]?.generation).toEqual(run.generation);
    expect(runs[1]?.plan).toEqual(run.plan);
    expect(runs[1]?.vramAvailable).toBe(false);
    store.close();
  });

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

  it('skips only the still-pending units of a candidate, preserving finished ones', () => {
    const store = RunStore.open(tempDb());
    seedPlan(store);
    store.completeWorkUnit(generation('unit-1'), score('unit-1'));
    store.skipPendingUnits('cand-1', 'oom-suspect at context 4096');
    const results = store.listUnitResults('run-1');
    expect(results.find((r) => r.unit.id === 'unit-1')?.status).toBe('completed');
    expect(results.find((r) => r.unit.id === 'unit-2')?.status).toBe('skipped');
    expect(results.find((r) => r.unit.id === 'unit-3')?.failureReason).toContain('oom-suspect');
    store.close();
  });

  it('reads candidates back with fit prediction, outcome, and offload flag', () => {
    const store = RunStore.open(tempDb());
    seedPlan(store);
    store.finishCandidate('cand-1', {
      status: 'oom',
      statusReason: 'oom-suspect during load at context 4096: model failed to load',
      peakVramMib: null,
      vramSamples: [],
      deterministic: null,
    });
    store.flagOffloadSuspect('cand-1', 'suspected cpu/gpu split: throughput collapsed');
    const candidates = store.listCandidates('run-1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.record).toEqual(candidate);
    expect(candidates[0]?.status).toBe('oom');
    expect(candidates[0]?.statusReason).toContain('oom-suspect during load');
    expect(candidates[0]?.offloadSuspectReason).toContain('cpu/gpu split');
    expect(candidates[0]?.deterministic).toBeNull();
    store.close();
  });

  it('stores candidate outcomes including the nondeterminism flag', () => {
    const dbPath = tempDb();
    const store = RunStore.open(dbPath);
    seedPlan(store);
    store.finishCandidate('cand-1', {
      status: 'completed',
      statusReason: null,
      peakVramMib: 4212,
      vramSamples: [[0, 900], [200, 4212]],
      deterministic: false,
    });
    store.close();
    const reopened = RunStore.open(dbPath);
    const read = reopened.listCandidates('run-1')[0];
    expect(read?.peakVramMib).toBe(4212);
    expect(read?.deterministic).toBe(false);
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

describe('RunStore provenance', () => {
  it('round-trips pack provenance on the run record', () => {
    const store = RunStore.open(tempDb());
    const provenance = {
      source: 'notes.md', source_sha256: 'a'.repeat(64),
      drafted_by: 'gemma3:4b (ollama 0.23.1)', drafted_at: '2026-07-17', reviewed: false,
    };
    store.createRun({ ...run, id: 'run-prov', packProvenance: provenance });
    const loaded = store.listRuns().find((r) => r.id === 'run-prov');
    expect(loaded?.packProvenance).toEqual(provenance);
    store.close();
  });

  it('adds the provenance column to a database created before it existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quantproof-store-'));
    dirs.push(dir);
    const dbPath = join(dir, 'old.db');
    const { default: Database } = await import('better-sqlite3');
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL,
      pack_name TEXT NOT NULL, pack_dir TEXT NOT NULL, task_type TEXT NOT NULL,
      scorer_name TEXT NOT NULL, generation_json TEXT NOT NULL,
      backend_version TEXT NOT NULL, gpu_name TEXT, driver_version TEXT,
      vram_available INTEGER NOT NULL, vram_unavailable_reason TEXT,
      plan_json TEXT NOT NULL
    );`);
    legacy.close();
    const store = RunStore.open(dbPath);
    store.createRun({ ...run, id: 'run-migrated' });
    expect(store.listRuns().find((r) => r.id === 'run-migrated')?.packProvenance).toBeNull();
    store.close();
  });
});
