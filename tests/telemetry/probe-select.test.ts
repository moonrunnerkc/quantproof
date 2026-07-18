import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { API_BACKEND_VRAM_REASON } from '../../src/backends/backend-select.js';
import { NO_TELEMETRY_REASON, selectMemoryProbes } from '../../src/telemetry/probe-select.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-select-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const nvidia = fake(
  'fake-nvidia-smi',
  `if [[ "$1" == *name* ]]; then echo "NVIDIA GeForce RTX 5070, 580.65.06, 12227"; exit 0; fi
echo "9000, 3000"`,
);
const missingNvidia = join(dir, 'no-such-nvidia-smi');
const unified = {
  sysctl: fake('sel-sysctl', `if [[ "$2" == machdep* ]]; then echo "Apple M5 Max"; else echo "68719476736"; fi`),
  swVers: fake('sel-sw-vers', 'echo "15.5"'),
  ps: fake('sel-ps', 'echo "1048576 ollama runner"'),
  platform: 'darwin' as const,
};

describe('selectMemoryProbes', () => {
  it('prefers nvidia-smi when it answers the identity query', () => {
    const set = selectMemoryProbes('ollama', { nvidiaBinary: nvidia, unified });
    expect(set.source).toBe('nvidia-smi');
    expect(set.gpu?.name).toBe('NVIDIA GeForce RTX 5070');
    expect(set.unavailableReason).toBeNull();
    expect(set.sampleOnce()).toEqual({ freeMib: 9000, usedMib: 3000 });
  });

  it('falls back to unified memory on Apple Silicon without nvidia-smi', () => {
    const set = selectMemoryProbes('ollama', { nvidiaBinary: missingNvidia, unified });
    expect(set.source).toBe('unified-memory');
    expect(set.gpu?.name).toBe('Apple M5 Max unified memory');
    expect(set.unavailableReason).toBeNull();
    expect(set.sampleOnce()?.usedMib).toBe(1024);
  });

  it('reports no telemetry with the reason when neither source works', async () => {
    const set = selectMemoryProbes('ollama', {
      nvidiaBinary: missingNvidia,
      unified: { ...unified, platform: 'linux' },
    });
    expect(set.source).toBe('none');
    expect(set.gpu).toBeNull();
    expect(set.unavailableReason).toBe(NO_TELEMETRY_REASON);
    expect(set.sampleOnce()).toBeNull();
    const result = await set.startProbe().stop();
    expect(result.available).toBe(false);
  });

  it('measures nothing for the api backend, by design', async () => {
    const set = selectMemoryProbes('anthropic', { nvidiaBinary: nvidia, unified });
    expect(set.source).toBe('api');
    expect(set.unavailableReason).toBe(API_BACKEND_VRAM_REASON);
    expect(set.sampleOnce()).toBeNull();
    const result = await set.startProbe().stop();
    expect(result.available).toBe(false);
  });
});
