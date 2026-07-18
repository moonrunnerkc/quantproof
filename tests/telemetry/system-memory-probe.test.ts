import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_UNAVAILABLE_REASON,
  querySystemIdentity,
  querySystemMemoryOnce,
  startSystemMemoryProbe,
} from '../../src/telemetry/system-memory-probe.js';

const dir = mkdtempSync(join(tmpdir(), 'qp-sysmem-'));

function fakeMeminfo(name: string, lines: readonly string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function fakePs(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const MEMINFO = fakeMeminfo('meminfo', [
  'MemTotal:       16000000 kB',
  'MemFree:         5000000 kB',
  'MemAvailable:   10240000 kB',
]);

describe('querySystemIdentity', () => {
  it('reports system RAM with the kernel release and total memory', () => {
    const identity = querySystemIdentity({ meminfoPath: MEMINFO, osRelease: '6.17.0-test' });
    expect(identity).toEqual({
      name: 'system RAM',
      driverVersion: 'kernel 6.17.0-test',
      totalMib: Math.round(16000000 / 1024),
    });
  });

  it('returns null when /proc/meminfo is unreadable', () => {
    expect(querySystemIdentity({ meminfoPath: join(dir, 'absent') })).toBeNull();
  });

  it('returns null when MemTotal is missing', () => {
    const path = fakeMeminfo('no-total', ['MemAvailable:   10240000 kB']);
    expect(querySystemIdentity({ meminfoPath: path })).toBeNull();
  });
});

describe('querySystemMemoryOnce', () => {
  it('uses MemAvailable as the free budget and the remainder as used', () => {
    const snapshot = querySystemMemoryOnce({ meminfoPath: MEMINFO });
    expect(snapshot).toEqual({
      freeMib: Math.round(10240000 / 1024),
      usedMib: Math.round(16000000 / 1024) - Math.round(10240000 / 1024),
    });
  });

  it('returns null when MemAvailable is missing', () => {
    const path = fakeMeminfo('no-avail', ['MemTotal:       16000000 kB']);
    expect(querySystemMemoryOnce({ meminfoPath: path })).toBeNull();
  });
});

describe('startSystemMemoryProbe', () => {
  it('tracks the peak resident memory of matching processes only', async () => {
    const ps = fakePs('ps-ollama', [
      'echo "2097152 /usr/local/bin/ollama serve"',
      'echo "1048576 /tmp/ollama/runner --model x"',
      'echo "9437184 /opt/google/chrome/chrome"',
    ].join('\n'));
    const probe = startSystemMemoryProbe(['ollama'], {
      meminfoPath: MEMINFO, ps, intervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 90));
    const result = await probe.stop();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.peakMib).toBe(3072);
      expect(result.gpu.name).toBe('system RAM');
      expect(result.samples.length).toBeGreaterThan(0);
    }
  });

  it('resolves unavailable with the reason when meminfo is unreadable', async () => {
    const probe = startSystemMemoryProbe(['ollama'], { meminfoPath: join(dir, 'absent') });
    expect(probe.unavailableReason).toBe(SYSTEM_UNAVAILABLE_REASON);
    const result = await probe.stop();
    expect(result).toEqual({ available: false, reason: SYSTEM_UNAVAILABLE_REASON });
  });
});
