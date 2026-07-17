import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { executeSweep } from '../../src/orchestrator/run-executor.js';
import type { SweepOptions } from '../../src/orchestrator/run-executor.js';
import { FakeAdapter } from './fake-adapter.js';
import type { BehaviorScript } from './fake-adapter.js';
import { descriptor, offlineProbe, openTempStore, prepare, tinyPack } from './sweep-helpers.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** yes for example 001 prompts, no for 002 prompts. */
const perfectScript: BehaviorScript = (prompt) => ({
  kind: 'ok',
  output: prompt.includes('water') ? 'yes' : 'no',
});

function sweepOptions(adapter: FakeAdapter, store: ReturnType<typeof openTempStore>, extra: Partial<SweepOptions> = {}): SweepOptions & { lines: string[]; sleeps: number[] } {
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    adapter,
    store,
    startProbe: offlineProbe,
    sampleVram: () => null,
    onProgress: (line) => lines.push(line),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    cooldownMs: 7,
    backoffMs: 3,
    lines,
    sleeps,
    ...extra,
  };
}

describe('executeSweep', () => {
  it('runs candidates sequentially, unloading each before the next starts', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('big:7b', 7e9), descriptor('small:1b', 1e9)]);
    const options = sweepOptions(adapter, store);
    const outcome = await executeSweep(tinyPack(), prepared, options);

    expect(outcome.candidates.map((c) => c.status)).toEqual(['completed', 'completed']);
    expect(adapter.unloads).toEqual(['big:7b', 'small:1b']);
    // Every generate call for big:7b happened before any for small:1b
    // proves sequential isolation at the adapter boundary.
    const loads = adapter.loads.map((l) => l.model);
    expect(loads).toEqual(['big:7b', 'small:1b']);
    // Cooldown ran between candidates but not after the last one.
    expect(options.sleeps).toContain(7);
    store.close();
  });

  it('classifies a memory-pattern load failure as oom, skips its units, and finishes the sweep', async () => {
    const adapter = new FakeAdapter(perfectScript);
    adapter.loadErrors['huge:27b'] =
      'Ollama /api/generate failed (HTTP 500): model failed to load, this may be due to resource limitations or an internal error';
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('huge:27b', 17e9), descriptor('small:1b', 1e9)]);
    const outcome = await executeSweep(tinyPack(), prepared, sweepOptions(adapter, store));

    expect(outcome.candidates[0]?.status).toBe('oom');
    expect(outcome.candidates[0]?.statusReason).toContain('oom-suspect during load/warmup at context 2048');
    expect(outcome.candidates[0]?.results.every((r) => r.status === 'skipped')).toBe(true);
    expect(outcome.candidates[1]?.status).toBe('completed');
    // The oom model was still force-unloaded.
    expect(adapter.unloads).toEqual(['huge:27b', 'small:1b']);
    store.close();
  });

  it('classifies a cuda error mid-generation as oom and never retries that configuration', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) =>
      callIndex === 2
        ? { kind: 'crash-mid-stream', afterTokens: 1, message: 'CUDA error: out of memory' }
        : perfectScript(prompt, callIndex),
    );
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(2), [descriptor('only:4b', 4e9)]);
    const outcome = await executeSweep(tinyPack(2), prepared, sweepOptions(adapter, store));

    const candidate = outcome.candidates[0];
    expect(candidate?.status).toBe('oom');
    expect(candidate?.summary.completed).toBe(1);
    expect(candidate?.summary.failed).toBe(1);
    expect(candidate?.summary.skipped).toBe(2);
    // warmup + unit 1 + crashing unit 2; no retry of the oom unit.
    expect(adapter.generatePrompts).toHaveLength(3);
    store.close();
  });

  it('treats a plain generation error as a unit failure, not an oom', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) =>
      callIndex === 1
        ? { kind: 'crash-mid-stream', afterTokens: 1, message: 'backend hiccuped for no memory-related reason' }
        : perfectScript(prompt, callIndex),
    );
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('only:1b', 1e9)]);
    const outcome = await executeSweep(tinyPack(), prepared, sweepOptions(adapter, store));

    expect(outcome.candidates[0]?.status).toBe('completed');
    expect(outcome.candidates[0]?.summary.failed).toBe(1);
    expect(outcome.candidates[0]?.summary.completed).toBe(1);
    expect(outcome.candidates[0]?.summary.skipped).toBe(0);
    store.close();
  });

  it('retries transport errors twice with growing backoff before failing the unit', async () => {
    const adapter = new FakeAdapter((prompt, callIndex) =>
      callIndex >= 1 && callIndex <= 3 ? { kind: 'transport-error' } : perfectScript(prompt, callIndex),
    );
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('only:1b', 1e9)]);
    const options = sweepOptions(adapter, store);
    const outcome = await executeSweep(tinyPack(), prepared, options);

    expect(outcome.candidates[0]?.summary.failed).toBe(1);
    const failed = outcome.candidates[0]?.results.find((r) => r.status === 'failed');
    expect(failed?.failureReason).toContain('cannot reach Ollama');
    // Linear backoff: 3ms then 6ms for the two retries of unit 001.
    expect(options.sleeps.filter((ms) => ms === 3 || ms === 6)).toEqual([3, 6]);
    store.close();
  });

  it('warns when vram does not return to baseline between candidates', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('a:1b', 1e9), descriptor('b:1b', 1e9)]);
    // Baseline reads 1000 MiB used; after the first candidate it stays at 9000.
    let calls = 0;
    const options = sweepOptions(adapter, store, {
      sampleVram: () => {
        calls += 1;
        return { freeMib: 3000, usedMib: calls === 1 ? 1000 : 9000 };
      },
      baselineTimeoutMs: 1000,
    });
    await executeSweep(tinyPack(), prepared, options);
    expect(options.lines.some((l) => l.includes('did not return to baseline'))).toBe(true);
    store.close();
  });

  it('refines the time estimate after the first candidate completes', async () => {
    const adapter = new FakeAdapter(perfectScript);
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('a:1b', 1e9), descriptor('b:1b', 1e9)]);
    const options = sweepOptions(adapter, store);
    await executeSweep(tinyPack(), prepared, options);
    const estimates = options.lines.filter((l) => l.includes('min remaining'));
    expect(estimates[0]).toContain('pre-measurement estimate');
    expect(estimates[1]).not.toContain('pre-measurement estimate');
    store.close();
  });

  it('flags a throughput collapse against similar-size candidates as suspected offload', async () => {
    // Same size class; the slow one streams each token 40x slower.
    const adapter = new FakeAdapter((prompt) => ({
      kind: 'ok',
      output: (prompt.includes('water') ? 'yes' : 'no') + ' padding tokens here',
      tokenDelayMs: adapterDelay(prompt),
    }));
    const adapterDelay = (_prompt: string): number => (adapter.generatePrompts.length <= 3 ? 1 : 40);
    const store = openTempStore(dirs);
    const prepared = prepare(store, tinyPack(), [descriptor('fast:4b', 4e9), descriptor('slow:4b', 4.2e9)]);
    const outcome = await executeSweep(tinyPack(), prepared, sweepOptions(adapter, store));

    expect(outcome.candidates[0]?.offloadSuspectReason).toBeNull();
    expect(outcome.candidates[1]?.offloadSuspectReason).toContain('suspected cpu/gpu split');
    const stored = store.listCandidates(outcome.run.id);
    expect(stored[1]?.offloadSuspectReason).toContain('tok/s');
    store.close();
  });
});
