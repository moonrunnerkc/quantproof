import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startVramProbe } from '../../src/telemetry/vram-probe.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-vram-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable fake nvidia-smi and returns its path. */
function fakeSmi(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const INFO_BRANCH = `if [[ "$1" == *name* ]]; then
  echo "NVIDIA GeForce RTX 5070, 580.65.06, 12227"
  exit 0
fi`;

describe('startVramProbe', () => {
  it('reports unavailable with the reason when the binary does not exist', async () => {
    const probe = startVramProbe({ binary: join(dir, 'no-such-nvidia-smi') });
    const result = await probe.stop();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain('not available');
      expect(result.reason).toContain('VRAM was not measured');
    }
  });

  it('reports unavailable when the binary exists but fails the identity query', async () => {
    const binary = fakeSmi('failing-smi', 'exit 1');
    const result = await startVramProbe({ binary }).stop();
    expect(result.available).toBe(false);
  });

  it('tracks peak and timeline from loop-mode samples and parses gpu identity', async () => {
    const binary = fakeSmi(
      'sampling-smi',
      `${INFO_BRANCH}
while true; do echo "3120"; echo "9840"; echo "7413"; sleep 0.02; done`,
    );
    const probe = startVramProbe({ binary, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 150));
    const result = await probe.stop();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.gpu).toEqual({
        name: 'NVIDIA GeForce RTX 5070',
        driverVersion: '580.65.06',
        totalMib: 12227,
      });
      expect(result.peakMib).toBe(9840);
      expect(result.samples.length).toBeGreaterThanOrEqual(3);
      expect(result.samples.every((s) => [3120, 9840, 7413].includes(s.usedMib))).toBe(true);
      const times = result.samples.map((s) => s.at);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('still returns collected samples when the sampler exits before stop', async () => {
    const binary = fakeSmi(
      'short-lived-smi',
      `${INFO_BRANCH}
echo "2048"
echo "4096"`,
    );
    const probe = startVramProbe({ binary, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 200));
    const result = await probe.stop();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.peakMib).toBe(4096);
      expect(result.samples).toHaveLength(2);
    }
  });

  it('reports unavailable when loop mode produces no parseable samples', async () => {
    const binary = fakeSmi(
      'silent-smi',
      `${INFO_BRANCH}
sleep 60`,
    );
    const probe = startVramProbe({ binary, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 50));
    const result = await probe.stop();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain('no samples');
    }
  });
});
