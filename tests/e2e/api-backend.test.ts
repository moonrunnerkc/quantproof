/**
 * Live end-to-end suite against the real Anthropic API: a two-example
 * slice of the ticket-classification pack on a haiku-class model, then
 * the report and bundle from the stored run. Costs a few hundred
 * tokens. Skips with a notice when ANTHROPIC_API_KEY is absent, so
 * machines and forks without the secret stay green.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { reportCommand } from '../../src/cli/command-report.js';
import { runCommand } from '../../src/cli/command-run.js';
import { verifyBundle } from '../../src/results/bundle.js';

const PACK = resolve(import.meta.dirname, '../../examples/ticket-classification');
const hasKey = (process.env['ANTHROPIC_API_KEY'] ?? '') !== '';
if (!hasKey) {
  console.warn('skipping the api-backend e2e suite: ANTHROPIC_API_KEY is not set');
}

const dir = mkdtempSync(join(tmpdir(), 'quantproof-api-e2e-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasKey)('quantproof run against the live Anthropic API', () => {
  it('sweeps, reports, and re-scores from the bundle', async () => {
    const db = join(dir, 'results.db');
    const config = join(dir, 'sweep.yaml');
    writeFileSync(config, 'backend: anthropic\ncandidates:\n  - claude-haiku-4-5\n');

    const report = await runCommand({ pack: PACK, config, db, limit: 2 });
    expect(report).toContain('anthropic api (sdk');
    expect(report).toContain('6 completed, 0 failed');
    expect(report).toMatch(/token spend: \d+ prompt \+ \d+ output tokens across 6 generations/);

    const markdownPath = join(dir, 'report.md');
    reportCommand({ db, markdown: true, out: markdownPath });
    const markdown = readFileSync(markdownPath, 'utf8');
    expect(markdown).toContain('via the Anthropic API');
    expect(markdown).toContain('not comparable to a local-model measurement');

    const bundlePath = join(dir, 'bundle.zip');
    reportCommand({ db, bundle: true, out: bundlePath });
    const verification = verifyBundle(readFileSync(bundlePath));
    expect(verification.checked).toBe(6);
    expect(verification.mismatches).toEqual([]);

    const key = process.env['ANTHROPIC_API_KEY'] ?? '';
    expect(readFileSync(db, 'latin1')).not.toContain(key);
    expect(readFileSync(bundlePath, 'latin1')).not.toContain(key);
  });
});
