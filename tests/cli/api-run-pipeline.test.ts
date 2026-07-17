import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reportCommand } from '../../src/cli/command-report.js';
import { runCommand } from '../../src/cli/command-run.js';
import { verifyBundle } from '../../src/results/bundle.js';
import { startFakeAnthropic } from '../helpers/fake-anthropic.js';
import type { FakeAnthropic } from '../helpers/fake-anthropic.js';

const KEY_CANARY = 'sk-ant-test-canary-never-persist-9999';
const savedKey = process.env['ANTHROPIC_API_KEY'];
const dir = mkdtempSync(join(tmpdir(), 'quantproof-api-pipeline-'));
const dbPath = join(dir, 'results.db');
const configPath = join(dir, 'sweep.yaml');
let api: FakeAnthropic;
let report = '';

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['ANTHROPIC_API_KEY'] = KEY_CANARY;
  api = await startFakeAnthropic({ completion: ['bil', 'ling'] });
  writeFileSync(configPath, 'backend: anthropic\ncandidates:\n  - claude-haiku-4-5\n  - claude-sonnet-5\n');
  report = await runCommand({
    pack: 'examples/ticket-classification',
    config: configPath,
    db: dbPath,
    limit: 2,
    baseUrl: api.baseUrl,
  });
}, 30000);

afterAll(() => {
  vi.restoreAllMocks();
  api.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = savedKey;
  }
});

describe('an api-backend sweep end to end', () => {
  it('labels the backend and renders vram as not applicable', () => {
    expect(report).toContain('anthropic api (sdk');
    expect(report).toContain('local VRAM does not apply');
    expect(report).toMatch(/claude-haiku-4-5.*n\/a/);
  });

  it('completes every unit for every candidate', () => {
    // 2 examples x 3 repetitions per candidate.
    expect(report.match(/6 completed, 0 failed/g)).toHaveLength(2);
  });

  it('states that the recommendation ranks on quality and latency only', () => {
    expect(report.replace(/\s+/g, ' ')).toContain('the ranking uses quality and latency only (no local footprint applies)');
  });

  it('prints the total token spend at the end', () => {
    // 12 generations x 42 prompt / 7 output tokens from the fake API.
    expect(report).toContain('token spend: 504 prompt + 84 output tokens across 12 generations');
  });

  it('writes a markdown report unmistakably labeled as an API run', () => {
    const out = join(dir, 'report.md');
    reportCommand({ db: dbPath, markdown: true, out });
    const markdown = readFileSync(out, 'utf8');
    expect(markdown).toContain('# quantproof: ticket-classification via the Anthropic API');
    expect(markdown).toContain('not comparable to a local-model measurement');
    expect(markdown).toContain('| not applicable |');
    expect(markdown).toContain('API backend: inference runs on Anthropic hardware');
  });

  it('exports a bundle whose raw outputs re-score to identical values', () => {
    const out = join(dir, 'bundle.zip');
    reportCommand({ db: dbPath, bundle: true, out });
    const verification = verifyBundle(readFileSync(out));
    expect(verification.checked).toBe(12);
    expect(verification.mismatches).toEqual([]);
  });

  it('keeps the API key out of the results database and the bundle', () => {
    expect(readFileSync(dbPath, 'latin1')).not.toContain(KEY_CANARY);
    expect(readFileSync(join(dir, 'bundle.zip'), 'latin1')).not.toContain(KEY_CANARY);
  });
});
