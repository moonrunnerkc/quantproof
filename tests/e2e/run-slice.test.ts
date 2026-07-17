/**
 * Live smoke test against a running Ollama: the smallest pulled model
 * against a 3-example slice of the invoice-extraction starter pack.
 * Requires `ollama serve` and the gemma3:1b model (pulled on demand).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/cli/command-run.js';
import { RunStore } from '../../src/results/run-store.js';

const MODEL = 'gemma3:1b';
const PACK = resolve(import.meta.dirname, '../../examples/invoice-extraction');

const dir = mkdtempSync(join(tmpdir(), 'quantproof-e2e-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('quantproof run against live ollama', () => {
  it('runs a 3-example slice and produces a full journal plus a report table', async () => {
    const db = join(dir, 'results.db');
    const report = await runCommand({ pack: PACK, model: MODEL, db, limit: 3 });

    expect(report).toContain(`invoice-extraction x ${MODEL}`);
    expect(report).toContain('quality (mean score)');
    expect(report).toContain('ttft median');
    expect(report).toContain('peak vram');
    expect(report).toContain('ollama');
    expect(report).toContain('repro: quantproof run');

    expect(existsSync(db)).toBe(true);
    const store = RunStore.open(db);
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.packName).toBe('invoice-extraction');
    expect(runs[0]?.backendVersion).toMatch(/^ollama /);
    // 3 examples x 3 repetitions, warmup not journaled.
    const results = store.listUnitResults(runs[0]?.id ?? '');
    expect(results).toHaveLength(9);
    for (const result of results) {
      expect(result.status).toBe('completed');
      expect(result.generation?.output.length).toBeGreaterThan(0);
      expect(result.generation?.wallMs).toBeGreaterThan(0);
      expect(result.generation?.requestOptions).toMatchObject({
        model: MODEL,
        options: { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 512 },
      });
      expect(result.score?.scorerName).toBe('field-f1');
      expect(typeof result.score?.score).toBe('number');
    }
    store.close();
  });
});
