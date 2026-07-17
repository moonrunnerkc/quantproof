import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { reportCommand } from '../../src/cli/command-report.js';
import { packFingerprint } from '../../src/orchestrator/recovery.js';
import { verifyBundle } from '../../src/results/bundle.js';
import { RunStore } from '../../src/results/run-store.js';
import { scoreWithGates } from '../../src/scoring/gate-composition.js';
import { loadStarterPack } from '../helpers/starter-packs.js';
import { runRecord } from '../report/report-fixtures.js';

const packDir = resolve(import.meta.dirname, '../../examples/ticket-classification');
const { pack, primary, gates } = loadStarterPack('ticket-classification');
const dir = mkdtempSync(join(tmpdir(), 'quantproof-report-cmd-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Journals one completed run with genuinely scored outputs. */
function seedRun(dbPath: string): string {
  const store = RunStore.open(dbPath);
  const run = runRecord({
    id: 'run-report-test', packDir, packName: pack.manifest.name,
    scorerName: pack.manifest.scorer,
    plan: {
      explicitModel: null, configPath: null, configFingerprint: null,
      packFingerprint: packFingerprint(packDir), limit: 2, force: false,
    },
  });
  store.createRun(run);
  store.createCandidate({
    id: 'c1', runId: run.id, modelName: 'gemma3:1b', digest: 'abcdef0123456789',
    quantization: 'Q4_K_M', parameterSize: '999.89M', sizeBytes: 815_319_791,
    fitVerdict: 'unknown', predictedPeakMib: 1854, fitDetails: {},
  });
  const examples = pack.examples.slice(0, 2);
  const units = examples.map((example, i) => ({
    id: `u${String(i)}`, runId: run.id, candidateId: 'c1', exampleId: example.id, repetition: 1,
  }));
  store.createWorkUnits(units);
  for (const [i, example] of examples.entries()) {
    const output = String(example.expected);
    const record = scoreWithGates(output, example.expected, primary, gates);
    store.completeWorkUnit(
      {
        id: `g${String(i)}`, workUnitId: `u${String(i)}`, output, doneReason: 'stop',
        ttftMs: 100 + i, tokensPerSecond: 30, wallMs: 200, tokenCount: 3,
        promptTokenCount: 40, outputTokenCount: 3, requestOptions: {},
      },
      {
        id: `s${String(i)}`, workUnitId: `u${String(i)}`, scorerName: pack.manifest.scorer,
        score: record.score, pass: record.pass,
        details: JSON.parse(JSON.stringify(record.details)) as Record<string, unknown>,
      },
    );
  }
  store.finishCandidate('c1', {
    status: 'completed', statusReason: null, peakVramMib: null, vramSamples: [], deterministic: null,
  });
  store.close();
  return run.id;
}

describe('reportCommand', () => {
  const dbPath = join(dir, 'results.db');
  const runId = seedRun(dbPath);

  it('renders the newest run as the comparison table by default', () => {
    const text = reportCommand({ db: dbPath });
    expect(text).toContain('gemma3:1b');
    expect(text).toContain('recommend gemma3:1b');
  });

  it('accepts a run id prefix', () => {
    expect(reportCommand({ db: dbPath, runId: runId.slice(0, 6) })).toContain('gemma3:1b');
  });

  it('writes the markdown report with --markdown', () => {
    const out = join(dir, 'report.md');
    reportCommand({ db: dbPath, markdown: true, out });
    const markdown = readFileSync(out, 'utf8');
    expect(markdown).toContain('# quantproof: ticket-classification');
    expect(markdown).toContain('## Reproduce');
    expect(markdown).toContain(`quantproof run --pack ${packDir} --limit 2`);
  });

  it('exports a bundle whose raw outputs re-score to identical values', () => {
    const out = join(dir, 'bundle.zip');
    reportCommand({ db: dbPath, bundle: true, out });
    expect(existsSync(out)).toBe(true);
    const verification = verifyBundle(readFileSync(out));
    expect(verification.checked).toBe(2);
    expect(verification.mismatches).toEqual([]);
  });

  it('fails with the run list when the id is unknown', () => {
    expect(() => reportCommand({ db: dbPath, runId: 'nope' })).toThrow(/not in the results database/);
  });

  it('fails with a next step when the database has no runs', () => {
    expect(() => reportCommand({ db: join(dir, 'empty.db') })).toThrow(/run quantproof run --pack/);
  });
});
