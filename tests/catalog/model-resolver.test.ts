import { describe, expect, it } from 'vitest';
import type { ModelDescriptor } from '../../src/backends/backend-adapter.js';
import { resolveCandidates } from '../../src/catalog/model-resolver.js';
import { FakeAdapter } from '../orchestrator/fake-adapter.js';

const model = (name: string, sizeBytes: number, remote = false): ModelDescriptor => ({
  name, digest: 'd'.repeat(64), sizeBytes, quantization: 'Q4_K_M', parameterSize: null, remote,
});

function adapterWith(models: ModelDescriptor[]): FakeAdapter {
  const adapter = new FakeAdapter(() => ({ kind: 'ok', output: '' }));
  adapter.localModels = models;
  return adapter;
}

describe('resolveCandidates', () => {
  it('merges explicit candidates with the local store, explicit first', async () => {
    const adapter = adapterWith([model('local-a:7b', 7e9), model('local-b:3b', 3e9)]);
    const resolved = await resolveCandidates(adapter, {
      candidates: ['explicit:4b'],
      useLocalModels: true,
    });
    expect(resolved.candidates.map((c) => c.name)).toEqual(['explicit:4b', 'local-a:7b', 'local-b:3b']);
    expect(resolved.excluded).toEqual([]);
  });

  it('deduplicates a model named both explicitly and present locally', async () => {
    const adapter = adapterWith([model('gemma3:1b', 8e8)]);
    const resolved = await resolveCandidates(adapter, {
      candidates: ['gemma3:1b'],
      useLocalModels: true,
    });
    expect(resolved.candidates.map((c) => c.name)).toEqual(['gemma3:1b']);
  });

  it('skips the local store when use_local_models is false', async () => {
    const adapter = adapterWith([model('local-a:7b', 7e9), model('wanted:4b', 4e9)]);
    const resolved = await resolveCandidates(adapter, {
      candidates: ['wanted:4b'],
      useLocalModels: false,
    });
    expect(resolved.candidates.map((c) => c.name)).toEqual(['wanted:4b']);
  });

  it('excludes remote cloud models with a reason instead of sweeping them', async () => {
    const adapter = adapterWith([model('big-cloud:cloud', 400, true), model('local-b:3b', 3e9)]);
    const resolved = await resolveCandidates(adapter, { candidates: [], useLocalModels: true });
    expect(resolved.candidates.map((c) => c.name)).toEqual(['local-b:3b']);
    expect(resolved.excluded[0]?.name).toBe('big-cloud:cloud');
    expect(resolved.excluded[0]?.reason).toContain('cannot be measured locally');
  });
});
