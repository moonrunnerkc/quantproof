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
const meminfo = join(dir, 'sel-meminfo');
writeFileSync(meminfo, 'MemTotal:       16000000 kB\nMemAvailable:   10240000 kB\n');
const system = { meminfoPath: meminfo, osRelease: '6.17.0-test' };
const missingSystem = { meminfoPath: join(dir, 'no-such-meminfo') };

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

  it('falls back to system memory when there is no GPU telemetry at all', () => {
    const set = selectMemoryProbes('ollama', {
      nvidiaBinary: missingNvidia,
      nvidiaDevicePaths: [],
      unified: { ...unified, platform: 'linux' },
      system,
    });
    expect(set.source).toBe('system-memory');
    expect(set.gpu?.name).toBe('system RAM');
    expect(set.unavailableReason).toBeNull();
    expect(set.sampleOnce()).toEqual({
      freeMib: Math.round(10240000 / 1024),
      usedMib: Math.round(16000000 / 1024) - Math.round(10240000 / 1024),
    });
  });

  it('refuses the RSS fallback when an NVIDIA device exists without nvidia-smi', async () => {
    const devicePath = join(dir, 'fake-nvidia0');
    writeFileSync(devicePath, '');
    const set = selectMemoryProbes('ollama', {
      nvidiaBinary: missingNvidia,
      nvidiaDevicePaths: [devicePath],
      unified: { ...unified, platform: 'linux' },
      system,
    });
    expect(set.source).toBe('none');
    expect(set.gpu).toBeNull();
    expect(set.unavailableReason).toMatch(/NVIDIA GPU.*nvidia-smi/);
    expect(set.sampleOnce()).toBeNull();
    const result = await set.startProbe().stop();
    expect(result.available).toBe(false);
  });

  it('reports no telemetry with the reason when no source works', async () => {
    const set = selectMemoryProbes('ollama', {
      nvidiaBinary: missingNvidia,
      unified: { ...unified, platform: 'linux' },
      system: missingSystem,
    });
    expect(set.source).toBe('none');
    expect(set.gpu).toBeNull();
    expect(set.unavailableReason).toBe(NO_TELEMETRY_REASON);
    expect(set.sampleOnce()).toBeNull();
    const result = await set.startProbe().stop();
    expect(result.available).toBe(false);
  });

  it('polls the rapid-mlx server status instead of process memory for that backend', () => {
    const set = selectMemoryProbes('rapid-mlx', { nvidiaBinary: missingNvidia, unified });
    expect(set.source).toBe('rapid-mlx-status');
    expect(set.gpu?.name).toBe('Apple M5 Max unified memory');
    expect(set.unavailableReason).toBeNull();
    expect(set.sampleOnce()).toBeNull();
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
