import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRapidMlxProbe } from '../../src/telemetry/rapid-mlx-probe.js';

const dir = mkdtempSync(join(tmpdir(), 'quantproof-rmx-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const identity = {
  sysctl: fake('rmx-sysctl', `if [[ "$2" == machdep* ]]; then echo "Apple M5 Max"; else echo "68719476736"; fi`),
  swVers: fake('rmx-sw-vers', 'echo "15.5"'),
  platform: 'darwin' as const,
};

let server: Server;
let baseUrl: string;
let statusCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1/status') {
      statusCalls += 1;
      // Active memory grows per poll so the peak is distinguishable.
      res.end(JSON.stringify({ status: 'ok', metal: { active_memory_gb: statusCalls, peak_memory_gb: 99.9 } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake server has no port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('startRapidMlxProbe', () => {
  it('tracks the peak from its own active-memory samples, never the server lifetime peak', async () => {
    statusCalls = 0;
    const probe = startRapidMlxProbe(baseUrl, { identity, intervalMs: 20 });
    expect(probe.gpu?.name).toBe('Apple M5 Max unified memory');
    const deadline = Date.now() + 5000;
    while (statusCalls < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const result = await probe.stop();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.samples.length).toBeGreaterThanOrEqual(2);
      // active_memory_gb N maps to N GiB in MiB; lifetime 99.9 ignored.
      expect(result.peakMib % 1024).toBe(0);
      expect(result.peakMib).toBeLessThan(99 * 1024);
      const times = result.samples.map((s) => s.at);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('reports unavailable when the status endpoint never answers', async () => {
    const probe = startRapidMlxProbe('http://127.0.0.1:9', { identity, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    const result = await probe.stop();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain('memory was not measured');
    }
  });

  it('reports unavailable off Apple Silicon macOS', async () => {
    const probe = startRapidMlxProbe(baseUrl, { identity: { ...identity, platform: 'linux' } });
    const result = await probe.stop();
    expect(result.available).toBe(false);
  });
});
