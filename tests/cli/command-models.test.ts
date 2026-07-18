import { describe, expect, it, vi } from 'vitest';
import { modelsCommand } from '../../src/cli/command-models.js';
import type { ModelInfoSource } from '../../src/catalog/gguf-metadata.js';
import type { ModelDescriptor } from '../../src/backends/backend-adapter.js';
import { FakeAdapter } from '../orchestrator/fake-adapter.js';

/** Fake backend that also serves architecture metadata by name. */
class FakeCatalogAdapter extends FakeAdapter implements ModelInfoSource {
  infoByModel: Record<string, Readonly<Record<string, unknown>> | null> = {};

  showModelInfo(model: string): Promise<Readonly<Record<string, unknown>> | null> {
    return Promise.resolve(this.infoByModel[model] ?? null);
  }
}

const gemmaInfo = {
  'general.architecture': 'gemma3',
  'gemma3.block_count': 26,
  'gemma3.attention.head_count_kv': 1,
  'gemma3.attention.head_count': 4,
  'gemma3.attention.key_length': 256,
  'gemma3.attention.value_length': 256,
  'gemma3.embedding_length': 1152,
  'gemma3.context_length': 32768,
};

function descriptor(name: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    name, digest: 'd'.repeat(64), sizeBytes: 815_319_791,
    quantization: 'Q4_K_M', parameterSize: '999.89M', remote: false,
    ...overrides,
  };
}

function fakeAdapter(): FakeCatalogAdapter {
  const adapter = new FakeCatalogAdapter(() => ({ kind: 'ok', output: 'unused' }));
  adapter.localModels = [
    descriptor('gemma3:1b'),
    descriptor('mystery:7b', { sizeBytes: 4_500_000_000, quantization: null, parameterSize: null }),
    descriptor('kimi:cloud', { remote: true }),
  ];
  adapter.infoByModel = { 'gemma3:1b': gemmaInfo, 'mystery:7b': null };
  return adapter;
}

describe('modelsCommand', () => {
  it('lists local candidates with size, quant, and fit verdict', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const text = await modelsCommand({ adapter: fakeAdapter() });
    expect(text).toContain('2 candidates | fake-backend 1.0');
    expect(text).toMatch(/gemma3:1b\s+Q4_K_M\s+999\.89M\s+778/);
    expect(text).toMatch(/mystery:7b\s+\?\s+\?\s+4292/);
    vi.restoreAllMocks();
  });

  it('marks unresolvable architectures as unknown with the --force hint', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const text = await modelsCommand({ adapter: fakeAdapter() });
    expect(text).toMatch(/mystery:7b.*unknown/s);
    expect(text).toContain('architecture metadata unavailable');
    expect(text).toMatch(/attempt with\s+--force/);
    vi.restoreAllMocks();
  });

  it('shows excluded remote models with the reason', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const text = await modelsCommand({ adapter: fakeAdapter() });
    expect(text).toContain('excluded kimi:cloud: remote');
    vi.restoreAllMocks();
  });

  it('states the preview context and how a sweep chooses its own', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const text = await modelsCommand({ adapter: fakeAdapter(), context: 8192 });
    expect(text).toContain('fit predicted at context 8192');
    expect(text).toContain("each pack's declared context");
    vi.restoreAllMocks();
  });

  it('tells the user what to do when the store is empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = new FakeCatalogAdapter(() => ({ kind: 'ok', output: 'unused' }));
    const text = await modelsCommand({ adapter });
    expect(text).toContain('no local candidates; pull one (ollama pull gemma3:1b)');
    vi.restoreAllMocks();
  });
});

describe('modelsCommand on a CPU-only box', () => {
  it('prints real fit verdicts against system RAM via MemAvailable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'qp-models-sys-'));
    const meminfo = join(dir, 'meminfo');
    writeFileSync(meminfo, 'MemTotal:       16000000 kB\nMemAvailable:    4096000 kB\n');
    const text = await modelsCommand({
      adapter: fakeAdapter(),
      probeOptions: {
        nvidiaBinary: join(dir, 'no-such-nvidia-smi'),
        unified: { platform: 'linux' },
        system: { meminfoPath: meminfo, osRelease: '6.17.0-test' },
      },
    });
    expect(text).toContain('4000 MiB free for models (system RAM via MemAvailable, CPU inference)');
    expect(text).toMatch(/gemma3:1b.*fits/);
    expect(text).toMatch(/mystery:7b\s+.*unknown/);
  });

  it('names the missing MemAvailable field instead of claiming meminfo is unreadable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'qp-models-oldk-'));
    const meminfo = join(dir, 'meminfo');
    writeFileSync(meminfo, 'MemTotal:       16000000 kB\n');
    const text = await modelsCommand({
      adapter: fakeAdapter(),
      probeOptions: {
        nvidiaBinary: join(dir, 'no-such-nvidia-smi'),
        nvidiaDevicePaths: [],
        unified: { platform: 'linux' },
        system: { meminfoPath: meminfo, osRelease: '3.10.0-old' },
      },
    });
    expect(text).toContain('MemAvailable');
    expect(text).not.toContain('/proc/meminfo unreadable');
  });
});
