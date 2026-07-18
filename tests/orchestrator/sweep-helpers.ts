/**
 * Shared fixtures for sweep executor and recovery tests: a tiny
 * in-memory pack, an offline probe, and journal preparation over the
 * fake adapter boundary.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelDescriptor } from '../../src/backends/backend-adapter.js';
import { predictFit } from '../../src/catalog/fit-predictor.js';
import { prepareSweepJournal } from '../../src/orchestrator/run-executor.js';
import type { PreparedSweep } from '../../src/orchestrator/run-executor.js';
import type { PlanSnapshot } from '../../src/results/record-types.js';
import { RunStore } from '../../src/results/run-store.js';
import type { LoadedTaskPack } from '../../src/tasks/task-loader.js';
import type { VramProbe } from '../../src/telemetry/vram-probe.js';

export function tinyPack(runsPerExample = 1): LoadedTaskPack {
  return {
    manifest: {
      name: 'yesno',
      type: 'classification',
      scorer: 'exact-label',
      scorer_params: { labels: ['yes', 'no'] },
      generation: { context: 2048, max_tokens: 8, temperature: 0, seed: 42, runs_per_example: runsPerExample },
      prompt_template: './prompt.md',
      examples_dir: './examples',
      gates: [],
      provenance: null,
    },
    promptTemplate: 'Answer yes or no: {{input}}',
    examples: [
      { id: '001', sourcePath: '/fake/001.json', input: 'is water wet?', expected: 'yes' },
      { id: '002', sourcePath: '/fake/002.json', input: 'is fire cold?', expected: 'no' },
    ],
    scorerParams: { labels: ['yes', 'no'] },
    gates: [],
  };
}

export function descriptor(name: string, sizeBytes: number): ModelDescriptor {
  return { name, digest: 'd'.repeat(64), sizeBytes, quantization: 'Q4_K_M', parameterSize: null, remote: false };
}

export const offlineProbe = (): VramProbe => ({
  gpu: null,
  unavailableReason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
  stop: () =>
    Promise.resolve({
      available: false as const,
      reason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
    }),
});

export const snapshot: PlanSnapshot = {
  explicitModel: null,
  configPath: null,
  configFingerprint: null,
  packFingerprint: 'test-fingerprint',
  limit: null,
  force: false,
};

export function openTempStore(dirs: string[]): RunStore {
  const dir = mkdtempSync(join(tmpdir(), 'quantproof-sweep-'));
  dirs.push(dir);
  return RunStore.open(join(dir, 'results.db'));
}

/** Journals a fresh sweep for the given models over the tiny pack. */
export function prepare(
  store: RunStore,
  pack: LoadedTaskPack,
  models: readonly ModelDescriptor[],
): PreparedSweep {
  const assessments = models.map((d) => ({
    descriptor: d,
    architecture: null,
    fit: predictFit(d.sizeBytes, null, pack.manifest.generation.context, null),
  }));
  return prepareSweepJournal(
    store, pack, './packs/yesno',
    {
      included: assessments,
      skipped: [],
      unitsPerCandidate: pack.examples.length * pack.manifest.generation.runs_per_example,
      estimatedSecondsPerCandidate: 10,
    },
    snapshot,
    { backendVersion: 'fake-backend 1.0', gpu: null, vramUnavailableReason: 'no gpu in tests' },
  );
}
