import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildResume,
  configFingerprint,
  findResumableRun,
  packFingerprint,
  verifyNoDrift,
} from '../../src/orchestrator/recovery.js';
import { executeSweep } from '../../src/orchestrator/run-executor.js';
import { FakeAdapter } from './fake-adapter.js';
import { descriptor, offlineProbe, openTempStore, prepare, tinyPack } from './sweep-helpers.js';

let dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fakePackDir(): string {
  const dir = tempDir('quantproof-recpack-');
  writeFileSync(join(dir, 'task.yaml'), 'name: x\n');
  mkdirSync(join(dir, 'examples'));
  writeFileSync(join(dir, 'examples', '001.json'), '{"input":"a","expected":1}');
  return dir;
}

describe('fingerprints', () => {
  it('pack fingerprint is stable across reads and changes when any file changes', () => {
    const dir = fakePackDir();
    const before = packFingerprint(dir);
    expect(packFingerprint(dir)).toBe(before);
    writeFileSync(join(dir, 'examples', '001.json'), '{"input":"a","expected":2}');
    expect(packFingerprint(dir)).not.toBe(before);
  });

  it('config fingerprint is null for a null path and content-based otherwise', () => {
    expect(configFingerprint(null)).toBeNull();
    const dir = tempDir('quantproof-reccfg-');
    const path = join(dir, 'run.yaml');
    writeFileSync(path, 'candidates: []\n');
    const before = configFingerprint(path);
    writeFileSync(path, 'candidates: [gemma3:1b]\n');
    expect(configFingerprint(path)).not.toBe(before);
  });
});

describe('verifyNoDrift', () => {
  function runFor(packDir: string, configPath: string | null): Parameters<typeof verifyNoDrift>[0] {
    return {
      id: 'run-1', createdAtMs: 0, packName: 'x', packDir, taskType: 't', scorerName: 'exact-label',
      generation: { context: 2048, max_tokens: 8, temperature: 0, seed: 42, runs_per_example: 1 },
      backendVersion: 'fake', gpuName: null, driverVersion: null,
      vramAvailable: false, vramUnavailableReason: null,
      plan: {
        explicitModel: null, configPath,
        configFingerprint: configFingerprint(configPath),
        packFingerprint: packFingerprint(packDir),
        limit: null, force: false,
      },
    };
  }

  it('passes when nothing changed', () => {
    const packDir = fakePackDir();
    expect(() => verifyNoDrift(runFor(packDir, null))).not.toThrow();
  });

  it('aborts with an explanation when the pack changed since planning', () => {
    const packDir = fakePackDir();
    const run = runFor(packDir, null);
    writeFileSync(join(packDir, 'examples', '001.json'), '{"input":"changed","expected":1}');
    expect(() => verifyNoDrift(run)).toThrow(/changed on disk since run run-1 was planned.*two different packs/s);
  });

  it('aborts when the run config changed since planning', () => {
    const packDir = fakePackDir();
    const configDir = tempDir('quantproof-reccfg-');
    const configPath = join(configDir, 'run.yaml');
    writeFileSync(configPath, 'candidates: []\n');
    const run = runFor(packDir, configPath);
    writeFileSync(configPath, 'candidates: [other:1b]\n');
    expect(() => verifyNoDrift(run)).toThrow(/refuses to mix configurations/);
  });

  it('aborts when the run config file is gone', () => {
    const packDir = fakePackDir();
    const configDir = tempDir('quantproof-reccfg-');
    const configPath = join(configDir, 'run.yaml');
    writeFileSync(configPath, 'candidates: []\n');
    const run = runFor(packDir, configPath);
    rmSync(configPath);
    expect(() => verifyNoDrift(run)).toThrow(/no longer readable/);
  });
});

describe('findResumableRun and buildResume', () => {
  it('finds the newest run with pending units and rebuilds only unfinished non-oom work', async () => {
    const store = openTempStore(dirs);
    const pack = tinyPack(2);
    // Sweep 1: candidate a completes fully, candidate b OOMs on load,
    // candidate c is interrupted (simulated by never executing it).
    const adapter = new FakeAdapter((prompt) => ({ kind: 'ok', output: prompt.includes('water') ? 'yes' : 'no' }));
    adapter.loadErrors['b:9b'] = 'model failed to load, this may be due to resource limitations';
    const prepared = prepare(store, pack, [descriptor('a:1b', 1e9), descriptor('b:9b', 9e9), descriptor('c:2b', 2e9)]);
    // Execute only the first two candidates: the process "dies" before c.
    await executeSweep(pack, { run: prepared.run, entries: prepared.entries.slice(0, 2) }, {
      adapter, store, startProbe: offlineProbe, sampleVram: () => null,
      sleep: () => Promise.resolve(), cooldownMs: 0,
    });

    const resumable = findResumableRun(store);
    expect(resumable?.id).toBe(prepared.run.id);

    const resume = buildResume(store, resumable ?? prepared.run);
    // Only candidate c has pending units; a is done, b's were skipped as oom.
    expect(resume.entries).toHaveLength(1);
    expect(resume.entries[0]?.candidate.modelName).toBe('c:2b');
    expect(resume.entries[0]?.units).toHaveLength(4);
    store.close();
  });

  it('returns null when every run is complete', async () => {
    const store = openTempStore(dirs);
    const pack = tinyPack(1);
    const adapter = new FakeAdapter((prompt) => ({ kind: 'ok', output: prompt.includes('water') ? 'yes' : 'no' }));
    const prepared = prepare(store, pack, [descriptor('a:1b', 1e9)]);
    await executeSweep(pack, prepared, {
      adapter, store, startProbe: offlineProbe, sampleVram: () => null,
      sleep: () => Promise.resolve(), cooldownMs: 0,
    });
    expect(findResumableRun(store)).toBeNull();
    store.close();
  });

  it('after resume, every unit appears exactly once and finished units were not re-run', async () => {
    const store = openTempStore(dirs);
    const pack = tinyPack(2);
    const adapter = new FakeAdapter((prompt) => ({ kind: 'ok', output: prompt.includes('water') ? 'yes' : 'no' }));
    const prepared = prepare(store, pack, [descriptor('a:1b', 1e9), descriptor('c:2b', 2e9)]);
    // "Kill" after candidate a: only a executes.
    await executeSweep(pack, { run: prepared.run, entries: prepared.entries.slice(0, 1) }, {
      adapter, store, startProbe: offlineProbe, sampleVram: () => null,
      sleep: () => Promise.resolve(), cooldownMs: 0,
    });
    const generationIdsBefore = new Map(
      store.listUnitResults(prepared.run.id)
        .filter((r) => r.generation !== null)
        .map((r) => [r.unit.id, r.generation?.id]),
    );
    const callsBeforeResume = adapter.generatePrompts.length;

    const resume = buildResume(store, findResumableRun(store) ?? prepared.run);
    await executeSweep(pack, resume, {
      adapter, store, startProbe: offlineProbe, sampleVram: () => null,
      sleep: () => Promise.resolve(), cooldownMs: 0,
    });

    const results = store.listUnitResults(prepared.run.id);
    // 2 candidates x 2 examples x 2 reps: every unit exactly once, none pending.
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // Units finished before the kill kept their original generations.
    for (const [unitId, generationId] of generationIdsBefore) {
      expect(results.find((r) => r.unit.id === unitId)?.generation?.id).toBe(generationId);
    }
    // Resume ran only candidate c's units (4) plus its warmup.
    expect(adapter.generatePrompts.length - callsBeforeResume).toBe(5);
    store.close();
  });
});
