import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { ingestCommand } from '../../src/cli/command-ingest.js';
import { listScorers } from '../../src/scoring/scorer-registry.js';
import { loadTaskPack } from '../../src/tasks/task-loader.js';
import type { ModelInfoSource } from '../../src/catalog/gguf-metadata.js';
import type { BehaviorScript } from '../orchestrator/fake-adapter.js';
import { FakeAdapter } from '../orchestrator/fake-adapter.js';

const root = mkdtempSync(join(tmpdir(), 'qp-ingest-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const sourcePath = join(root, 'lwt-common-tasks.md');
writeFileSync(sourcePath, '# Common tasks\n\nSale banners, monthly challenges, listings.\n');

class FakeCatalogAdapter extends FakeAdapter implements ModelInfoSource {
  infoByModel: Record<string, Readonly<Record<string, unknown>> | null> = {};

  showModelInfo(model: string): Promise<Readonly<Record<string, unknown>> | null> {
    return Promise.resolve(this.infoByModel[model] ?? null);
  }
}

function validDraft(): string {
  return JSON.stringify({
    name: 'LWT Common Tasks',
    type: 'classification',
    scorer: 'exact-label',
    scorer_params: { labels: ['sale', 'challenge', 'listing'] },
    prompt: 'Classify the request into one bare label.\n\nRequest:\n{{input}}',
    examples: Array.from({ length: 12 }, (_, i) => ({
      input: `request ${String(i)}`,
      expected: ['sale', 'challenge', 'listing'][i % 3],
    })),
  });
}

function adapterWith(script: BehaviorScript): FakeCatalogAdapter {
  const adapter = new FakeCatalogAdapter(script);
  adapter.localModels = [
    {
      name: 'gemma3:4b', digest: 'd'.repeat(64), sizeBytes: 3_000_000_000,
      quantization: 'Q4_K_M', parameterSize: '4.3B', remote: false,
    },
  ];
  return adapter;
}

describe('ingestCommand', () => {
  it('drafts a pack the strict loader accepts, provenance recorded', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: validDraft() }));
    const dir = join(root, 'clean');
    const written = await ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter });
    const pack = loadTaskPack(written, listScorers());
    expect(pack.manifest.name).toBe('lwt-common-tasks');
    expect(pack.examples).toHaveLength(12);
    expect(pack.manifest.provenance?.drafted_by).toBe('gemma3:4b (fake-backend 1.0)');
    expect(pack.manifest.provenance?.source).toBe('lwt-common-tasks.md');
    expect(pack.manifest.provenance?.reviewed).toBe(false);
    expect(adapter.unloads).toContain('gemma3:4b');
    expect(adapter.generatePrompts[0]).toContain('Sale banners, monthly challenges');
  });

  it('feeds validation errors back and succeeds on the repair round', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const broken = validDraft().replace('{{input}}', 'INPUT GOES HERE');
    const adapter = adapterWith((_prompt, call) => ({
      kind: 'ok',
      output: call === 0 ? broken : validDraft(),
    }));
    const dir = join(root, 'repaired');
    await ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter });
    expect(adapter.generatePrompts).toHaveLength(2);
    expect(adapter.generatePrompts[1]).toContain('previous draft failed validation');
    expect(adapter.generatePrompts[1]).toContain('{{input}}');
    expect(loadTaskPack(dir, listScorers()).examples).toHaveLength(12);
  });

  it('writes a still-broken draft as-is and prints the errors', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    const offLabel = validDraft().replace('"sale",', '"clearance",');
    const adapter = adapterWith(() => ({ kind: 'ok', output: offLabel }));
    const dir = join(root, 'salvaged');
    const written = await ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter });
    expect(adapter.generatePrompts).toHaveLength(3);
    expect(existsSync(join(written, 'task.yaml'))).toBe(true);
    expect(logs.join('\n')).toContain('failed validation after 3 attempts');
    expect(logs.join('\n')).toContain('declared labels');
  });

  it('keeps an unsalvageable response on disk and says what to try', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: 'I cannot help with that.' }));
    const dir = join(root, 'refused');
    await expect(
      ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter }),
    ).rejects.toThrow(/never produced JSON.*--model/s);
    expect(readFileSync(`${dir}-draft-response.txt`, 'utf8')).toContain('I cannot help');
  });

  it('errors on an unreadable source with the path named', async () => {
    const adapter = adapterWith(() => ({ kind: 'ok', output: validDraft() }));
    await expect(
      ingestCommand({ source: join(root, 'absent.md'), adapter, model: 'gemma3:4b' }),
    ).rejects.toThrow(/cannot read.*absent\.md/);
  });

  it('picks the largest local model that fits when none is named', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: validDraft() }));
    adapter.localModels = [
      {
        name: 'gemma3:1b', digest: 'a'.repeat(64), sizeBytes: 815_319_791,
        quantization: 'Q4_K_M', parameterSize: '999.89M', remote: false,
      },
      {
        name: 'gemma3:27b', digest: 'b'.repeat(64), sizeBytes: 17_000_000_000,
        quantization: 'Q4_0', parameterSize: '27B', remote: false,
      },
    ];
    const arch = (blocks: number): Readonly<Record<string, unknown>> => ({
      'general.architecture': 'gemma3',
      'gemma3.block_count': blocks,
      'gemma3.attention.head_count_kv': 1,
      'gemma3.attention.head_count': 4,
      'gemma3.attention.key_length': 256,
      'gemma3.attention.value_length': 256,
      'gemma3.embedding_length': 1152,
      'gemma3.context_length': 32768,
    });
    adapter.infoByModel = { 'gemma3:1b': arch(26), 'gemma3:27b': arch(62) };
    const meminfo = join(root, 'meminfo');
    writeFileSync(meminfo, 'MemTotal:       16000000 kB\nMemAvailable:    8192000 kB\n');
    const dir = join(root, 'auto-picked');
    await ingestCommand({
      source: sourcePath,
      dir,
      adapter,
      probeOptions: {
        nvidiaBinary: join(root, 'no-such-nvidia-smi'),
        nvidiaDevicePaths: [],
        unified: { platform: 'linux' },
        system: { meminfoPath: meminfo },
      },
    });
    expect(adapter.loads[0]?.model).toBe('gemma3:1b');
    expect(loadTaskPack(dir, listScorers()).manifest.provenance?.drafted_by).toContain('gemma3:1b');
  });

  it('falls back to the largest local model when free memory is unknown', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: validDraft() }));
    adapter.localModels = [
      {
        name: 'gemma3:1b', digest: 'a'.repeat(64), sizeBytes: 815_319_791,
        quantization: 'Q4_K_M', parameterSize: '999.89M', remote: false,
      },
      {
        name: 'gemma3:27b', digest: 'b'.repeat(64), sizeBytes: 17_000_000_000,
        quantization: 'Q4_0', parameterSize: '27B', remote: false,
      },
    ];
    const dir = join(root, 'unknown-fit');
    await ingestCommand({
      source: sourcePath,
      dir,
      adapter,
      probeOptions: {
        nvidiaBinary: join(root, 'no-such-nvidia-smi'),
        nvidiaDevicePaths: [],
        unified: { platform: 'linux' },
        system: { meminfoPath: join(root, 'no-such-meminfo') },
      },
    });
    expect(adapter.loads[0]?.model).toBe('gemma3:27b');
  });

  it('refuses an existing non-empty target before spending a drafting generation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: validDraft() }));
    const dir = join(root, 'occupied');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.yaml'), 'name: existing\n');
    await expect(
      ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter }),
    ).rejects.toThrow(/already exists.*pick another directory/s);
    expect(adapter.generatePrompts).toHaveLength(0);
  });

  it('saves the draft response when the derived directory collides after drafting', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: validDraft() }));
    const cwd = process.cwd();
    const sandbox = join(root, 'derived-collision');
    mkdirSync(join(sandbox, 'lwt-common-tasks'), { recursive: true });
    writeFileSync(join(sandbox, 'lwt-common-tasks', 'task.yaml'), 'name: existing\n');
    process.chdir(sandbox);
    try {
      await expect(
        ingestCommand({ source: sourcePath, model: 'gemma3:4b', adapter }),
      ).rejects.toThrow(/already exists.*draft-response\.txt/s);
      expect(readFileSync(join(sandbox, 'lwt-common-tasks-draft-response.txt'), 'utf8')).toContain(
        '"scorer":"exact-label"',
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it('writes the unsalvageable response even when the target parent does not exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const adapter = adapterWith(() => ({ kind: 'ok', output: 'I cannot help with that.' }));
    const dir = join(root, 'nested', 'deeper', 'pack');
    await expect(
      ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter }),
    ).rejects.toThrow(/never produced JSON/);
    expect(readFileSync(`${dir}-draft-response.txt`, 'utf8')).toContain('I cannot help');
  });

  it('never prints "labels: undefined" for a salvaged draft without labels', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    const unknownScorer = validDraft()
      .replace('"exact-label"', '"vibes"')
      .replace('"scorer_params":{"labels":["sale","challenge","listing"]},', '');
    const adapter = adapterWith(() => ({ kind: 'ok', output: unknownScorer }));
    const dir = join(root, 'no-labels');
    await ingestCommand({ source: sourcePath, dir, model: 'gemma3:4b', adapter });
    expect(logs.join('\n')).not.toContain('labels: undefined');
  });
});
