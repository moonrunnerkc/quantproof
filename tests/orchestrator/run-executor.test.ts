import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeSingleModelRun } from '../../src/orchestrator/run-executor.js';
import { RunStore } from '../../src/results/run-store.js';
import type { LoadedTaskPack } from '../../src/tasks/task-loader.js';
import type { VramProbe } from '../../src/telemetry/vram-probe.js';
import { FakeAdapter } from './fake-adapter.js';
import type { BehaviorScript } from './fake-adapter.js';

let dirs: string[] = [];
function openStore(): RunStore {
  const dir = mkdtempSync(join(tmpdir(), 'quantproof-exec-'));
  dirs.push(dir);
  return RunStore.open(join(dir, 'results.db'));
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function pack(runsPerExample: number): LoadedTaskPack {
  return {
    manifest: {
      name: 'yesno',
      type: 'classification',
      scorer: 'exact-label',
      scorer_params: { labels: ['yes', 'no'] },
      generation: {
        context: 2048,
        max_tokens: 8,
        temperature: 0,
        seed: 42,
        runs_per_example: runsPerExample,
      },
      prompt_template: './prompt.md',
      examples_dir: './examples',
      gates: [],
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

const offlineProbe = (): VramProbe => ({
  gpu: null,
  unavailableReason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
  stop: () =>
    Promise.resolve({
      available: false as const,
      reason: 'nvidia-smi is not available on this machine, so VRAM was not measured',
    }),
});

/** yes for example 001 prompts, no for 002 prompts. */
const perfectScript: BehaviorScript = (prompt) => ({
  kind: 'ok',
  output: prompt.includes('water') ? 'yes' : 'no',
});

function execute(adapter: FakeAdapter, store: RunStore, runsPerExample = 2, lines: string[] = []) {
  return executeSingleModelRun(pack(runsPerExample), './packs/yesno', 'fake-model:1b', {
    adapter,
    store,
    startProbe: offlineProbe,
    onProgress: (line) => lines.push(line),
  });
}

describe('executeSingleModelRun', () => {
  it('completes every unit, journals scores, and reports the summary', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openStore();
    const outcome = await execute(adapter, store);
    expect(outcome.summary.completed).toBe(4);
    expect(outcome.summary.failed).toBe(0);
    expect(outcome.summary.meanScore).toBe(1);
    expect(outcome.summary.passRate).toBe(1);
    expect(outcome.results.every((r) => r.generation !== null && r.score !== null)).toBe(true);
    store.close();
  });

  it('runs one untimed warmup before the timed units and does not journal it', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openStore();
    const lines: string[] = [];
    const outcome = await execute(adapter, store, 2, lines);
    // 1 warmup + 2 examples x 2 repetitions.
    expect(adapter.generatePrompts).toHaveLength(5);
    expect(lines[0]).toContain('warmup');
    expect(outcome.results).toHaveLength(4);
    store.close();
  });

  it('loads at the manifest context and force-unloads exactly once afterward', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openStore();
    await execute(adapter, store);
    expect(adapter.loads).toEqual([{ model: 'fake-model:1b', context: 2048 }]);
    expect(adapter.unloads).toEqual(['fake-model:1b']);
    store.close();
  });

  it('records the exact request options used, for reproducibility', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openStore();
    const outcome = await execute(adapter, store);
    expect(outcome.results[0]?.generation?.requestOptions).toEqual({
      model: 'fake-model:1b',
      options: { temperature: 0, seed: 42, num_predict: 8, num_ctx: 2048 },
    });
    store.close();
  });

  it('derives timing from a slow stream: positive ttft and a real token rate', async () => {
    const adapter = new FakeAdapter((prompt) => ({
      kind: 'ok',
      output: prompt.includes('water') ? 'yes' : 'no',
      tokenDelayMs: 8,
    }));
    const store = openStore();
    const outcome = await execute(adapter, store, 1);
    const generation = outcome.results[0]?.generation;
    expect(generation?.ttftMs).toBeGreaterThan(0);
    expect(generation?.tokensPerSecond).toBeGreaterThan(0);
    expect(generation?.tokensPerSecond).toBeLessThan(1000);
    store.close();
  });

  it('journals a mid-generation crash as a failed unit and keeps going', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) =>
      callIndex === 2
        ? { kind: 'crash-mid-stream', afterTokens: 2, message: 'backend died mid-generation' }
        : perfectScript(prompt, callIndex),
    );
    const store = openStore();
    const outcome = await execute(adapter, store);
    expect(outcome.summary.failed).toBe(1);
    expect(outcome.summary.completed).toBe(3);
    const failed = outcome.results.find((r) => r.status === 'failed');
    expect(failed?.failureReason).toContain('died mid-generation');
    expect(adapter.unloads).toHaveLength(1);
    store.close();
  });

  it('retries transport errors twice and completes when the backend recovers', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) =>
      callIndex === 1 || callIndex === 2 ? { kind: 'transport-error' } : perfectScript(prompt, callIndex),
    );
    const store = openStore();
    const outcome = await execute(adapter, store, 1);
    expect(outcome.summary.failed).toBe(0);
    expect(outcome.summary.completed).toBe(2);
    // warmup + (unit 1 x 3 attempts) + unit 2.
    expect(adapter.generatePrompts).toHaveLength(5);
    store.close();
  });

  it('fails the unit when transport errors exhaust both retries', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) =>
      callIndex >= 1 && callIndex <= 3 ? { kind: 'transport-error' } : perfectScript(prompt, callIndex),
    );
    const store = openStore();
    const outcome = await execute(adapter, store, 1);
    expect(outcome.summary.failed).toBe(1);
    const failed = outcome.results.find((r) => r.status === 'failed');
    expect(failed?.failureReason).toContain('cannot reach Ollama');
    store.close();
  });

  it('flags identical outputs across repetitions as deterministic', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openStore();
    const outcome = await execute(adapter, store, 3);
    expect(outcome.summary.outputsDeterministic).toBe(true);
    store.close();
  });

  it('flags differing outputs across repetitions as nondeterministic', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) => ({
      kind: 'ok',
      output: `${prompt.includes('water') ? 'yes' : 'no'}${callIndex % 2 === 0 ? '' : ' '}`,
    }));
    const store = openStore();
    const outcome = await execute(adapter, store, 2);
    expect(outcome.summary.outputsDeterministic).toBe(false);
    store.close();
  });

  it('unloads and stops the probe even when load itself throws', async () => {
    class ExplodingAdapter extends FakeAdapter {
      override load(): Promise<void> {
        return Promise.reject(new Error('model does not fit'));
      }
    }
    const adapter = new ExplodingAdapter(perfectScript);
    const store = openStore();
    let probeStopped = false;
    const probe: VramProbe = {
      gpu: null,
      unavailableReason: 'unavailable',
      stop: () => {
        probeStopped = true;
        return Promise.resolve({ available: false as const, reason: 'unavailable' });
      },
    };
    await expect(
      executeSingleModelRun(pack(1), './packs/yesno', 'fake-model:1b', {
        adapter,
        store,
        startProbe: () => probe,
      }),
    ).rejects.toThrow('model does not fit');
    expect(adapter.unloads).toEqual(['fake-model:1b']);
    expect(probeStopped).toBe(true);
    store.close();
  });

  it('carries the vram-unavailable state into the run record', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openStore();
    const outcome = await execute(adapter, store, 1);
    expect(outcome.run.vramAvailable).toBe(false);
    expect(outcome.run.vramUnavailableReason).toContain('nvidia-smi');
    expect(outcome.vram.available).toBe(false);
    store.close();
  });
});
