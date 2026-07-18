import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  queryUnifiedIdentity,
  queryUnifiedMemoryOnce,
  startUnifiedMemoryProbe,
  UNIFIED_BUDGET_FRACTION,
} from '../../src/telemetry/unified-memory-probe.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-um-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable fake binary and returns its path. */
function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// 64 GiB machine: hw.memsize in bytes, brand string per sysctl key.
const sysctl = fake(
  'sysctl-ok',
  `if [[ "$2" == machdep* ]]; then echo "Apple M5 Max"; else echo "68719476736"; fi`,
);
const swVers = fake('sw-vers-ok', 'echo "15.5"');

// Two ollama processes (server 256 MiB, runner 14336 MiB) plus noise.
const ps = fake(
  'ps-ok',
  `echo "262144 /Applications/Ollama.app/Contents/MacOS/Ollama"
echo "14680064 /Applications/Ollama.app/Contents/Resources/ollama runner"
echo "9999999 /Applications/Chrome.app/Contents/MacOS/Chrome"`,
);

const darwin = { sysctl, swVers, ps, platform: 'darwin' as const };

describe('queryUnifiedIdentity', () => {
  it('reports the chip, macOS version, and total memory in MiB', () => {
    expect(queryUnifiedIdentity(darwin)).toEqual({
      name: 'Apple M5 Max unified memory',
      driverVersion: 'macOS 15.5',
      totalMib: 65536,
    });
  });

  it('returns null off macOS so the selector can fall through', () => {
    expect(queryUnifiedIdentity({ ...darwin, platform: 'linux' })).toBeNull();
  });

  it('returns null when sysctl fails instead of guessing', () => {
    expect(queryUnifiedIdentity({ ...darwin, sysctl: fake('sysctl-bad', 'exit 1') })).toBeNull();
  });
});

describe('queryUnifiedMemoryOnce', () => {
  it('sums only the backend processes and derives free from the 75% budget', () => {
    const snapshot = queryUnifiedMemoryOnce(['ollama'], darwin);
    expect(snapshot?.usedMib).toBe(256 + 14336);
    const budget = Math.floor(65536 * UNIFIED_BUDGET_FRACTION);
    expect(snapshot?.freeMib).toBe(budget - (256 + 14336));
  });

  it('floors free at zero rather than reporting negative headroom', () => {
    const huge = fake('ps-huge', 'echo "68719476736 ollama runner"');
    expect(queryUnifiedMemoryOnce(['ollama'], { ...darwin, ps: huge })?.freeMib).toBe(0);
  });

  it('returns null when ps fails instead of fabricating a sample', () => {
    expect(queryUnifiedMemoryOnce(['ollama'], { ...darwin, ps: fake('ps-bad', 'exit 1') })).toBeNull();
  });
});

describe('startUnifiedMemoryProbe', () => {
  it('exposes machine identity at start for the run record', async () => {
    const probe = startUnifiedMemoryProbe(['ollama'], { ...darwin, intervalMs: 20 });
    expect(probe.gpu?.name).toBe('Apple M5 Max unified memory');
    expect(probe.unavailableReason).toBeNull();
    await probe.stop();
  });

  it('reports unavailable with the reason off Apple Silicon macOS', async () => {
    const probe = startUnifiedMemoryProbe(['ollama'], { ...darwin, platform: 'win32' });
    expect(probe.gpu).toBeNull();
    const result = await probe.stop();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain('memory was not measured');
    }
  });

  it('tracks the peak across growing samples via a counter-driven fake ps', async () => {
    const counter = join(dir, 'tick-count');
    writeFileSync(counter, '0');
    const growing = fake(
      'ps-growing',
      `n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"
echo "$((n * 1048576)) ollama runner"`,
    );
    const probe = startUnifiedMemoryProbe(['ollama'], { ...darwin, ps: growing, intervalMs: 20 });
    // Wait on observed ticks, not wall time: under a loaded test pool a
    // fixed sleep can end before the sampler has run twice.
    const deadline = Date.now() + 5000;
    while (Number.parseInt(readFileSync(counter, 'utf8'), 10) < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const result = await probe.stop();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.samples.length).toBeGreaterThanOrEqual(2);
      const last = result.samples[result.samples.length - 1];
      expect(result.peakMib).toBe(last?.usedMib);
      const times = result.samples.map((s) => s.at);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('caps the timeline by decimation while the peak keeps full precision', async () => {
    const counter = join(dir, 'cap-count');
    writeFileSync(counter, '0');
    const spiking = fake(
      'ps-spiking',
      `n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"
if [[ "$n" == "5" ]]; then echo "104857600 ollama runner"; else echo "$((n * 1048576)) ollama runner"; fi`,
    );
    const probe = startUnifiedMemoryProbe(['ollama'], {
      ...darwin, ps: spiking, intervalMs: 15, timelineCap: 6,
    });
    const deadline = Date.now() + 8000;
    while (Number.parseInt(readFileSync(counter, 'utf8'), 10) < 9 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const result = await probe.stop();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.samples.length).toBeLessThanOrEqual(6);
      expect(result.peakMib).toBe(102400);
    }
  });

  it('reports unavailable when ps never produces a sample', async () => {
    const probe = startUnifiedMemoryProbe(['ollama'], {
      ...darwin, ps: join(dir, 'no-such-ps'), intervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 80));
    const result = await probe.stop();
    expect(result.available).toBe(false);
  });
});
