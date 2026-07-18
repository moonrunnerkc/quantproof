/**
 * Live smoke test against a running Rapid-MLX server: whatever model
 * it serves against a 2-example slice of the ticket-classification
 * starter pack. Skips with a notice when no server answers at
 * http://localhost:8000, so machines without Rapid-MLX stay green.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/cli/command-run.js';
import { RunStore } from '../../src/results/run-store.js';

const PACK = resolve(import.meta.dirname, '../../examples/ticket-classification');

const serverUp = await fetch('http://localhost:8000/health').then(
  (r) => r.ok,
  () => false,
);
if (!serverUp) {
  console.warn('skipping the rapid-mlx e2e suite: no server at http://localhost:8000 (start it with: rapid-mlx serve <model>)');
}

const dir = mkdtempSync(join(tmpdir(), 'quantproof-rmx-e2e-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!serverUp)('quantproof run against live rapid-mlx', () => {
  it('sweeps the served model over a 2-example slice with measured memory', async () => {
    const config = join(dir, 'rapid.yaml');
    writeFileSync(config, 'backend: rapid-mlx\n');
    const db = join(dir, 'results.db');
    const report = await runCommand({ pack: PACK, config, db, limit: 2 });

    expect(report).toContain('ticket-classification x ');
    expect(report).toContain('peak memory');
    expect(report).toContain('rapid-mlx');
    expect(report).toContain('repro: quantproof run');

    const store = RunStore.open(db);
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.backendVersion).toMatch(/^rapid-mlx /);
    const results = store.listUnitResults(runs[0]?.id ?? '');
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.status).toBe('completed');
      expect(result.generation?.output.length).toBeGreaterThan(0);
      expect(result.generation?.requestOptions).toMatchObject({
        temperature: 0,
        seed: 42,
        prompt_cache: 'cleared before request',
      });
    }
    store.close();
  });
});
