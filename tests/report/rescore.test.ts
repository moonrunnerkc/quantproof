import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packFingerprint } from '../../src/orchestrator/recovery.js';
import { rescoreUnits } from '../../src/report/rescore.js';
import { scoreWithGates } from '../../src/scoring/gate-composition.js';
import type { UnitResult } from '../../src/results/record-types.js';
import { loadStarterPack } from '../helpers/starter-packs.js';
import { runRecord } from './report-fixtures.js';

const packDir = resolve(import.meta.dirname, '../../examples/ticket-classification');
const { pack, primary, gates } = loadStarterPack('ticket-classification');

function matchingRun(): ReturnType<typeof runRecord> {
  return runRecord({
    packDir,
    packName: pack.manifest.name,
    plan: {
      explicitModel: null, configPath: null, configFingerprint: null,
      packFingerprint: packFingerprint(packDir), limit: null, force: false,
    },
  });
}

function storedUnit(exampleId: string, output: string, stored: { score: number; pass: boolean; details: Record<string, unknown> }): UnitResult {
  const id = `u-${exampleId}`;
  return {
    unit: { id, runId: 'run-1', candidateId: 'c1', exampleId, repetition: 1 },
    status: 'completed',
    failureReason: null,
    generation: {
      id: `g-${id}`, workUnitId: id, output, doneReason: 'stop', ttftMs: 100,
      tokensPerSecond: 30, wallMs: 300, tokenCount: 3, promptTokenCount: 40,
      outputTokenCount: 3, requestOptions: {},
    },
    score: { id: `s-${id}`, workUnitId: id, scorerName: pack.manifest.scorer, ...stored },
  };
}

function truthfullyScored(exampleId: string, output: string): UnitResult {
  const expected = pack.examples.find((e) => e.id === exampleId)?.expected;
  const record = scoreWithGates(output, expected, primary, gates);
  return storedUnit(exampleId, output, {
    score: record.score,
    pass: record.pass,
    details: JSON.parse(JSON.stringify(record.details)) as Record<string, unknown>,
  });
}

describe('rescoreUnits', () => {
  it('passes through untouched with no notes when stored scores reproduce', () => {
    const first = pack.examples[0];
    const units = [truthfullyScored(first?.id ?? '', String(first?.expected))];
    const result = rescoreUnits(matchingRun(), units);
    expect(result.notes).toEqual([]);
    expect(result.units).toEqual(units);
    expect(result.pack).not.toBeNull();
  });

  it('replaces stale stored scores and says how many changed', () => {
    const first = pack.examples[0];
    const stale = storedUnit(first?.id ?? '', String(first?.expected), {
      score: 0.5, pass: false, details: { note: 'scored by an older scorer version' },
    });
    const result = rescoreUnits(matchingRun(), [stale, truthfullyScored(pack.examples[1]?.id ?? '', 'garbage')]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('1 of 2 scores changed');
    expect(result.units[0]?.score?.score).toBe(1);
    expect(result.units[0]?.score?.pass).toBe(true);
  });

  it('skips re-scoring on pack drift and says stored scores are shown', () => {
    const run = runRecord({
      packDir,
      plan: {
        explicitModel: null, configPath: null, configFingerprint: null,
        packFingerprint: 'fingerprint-from-before-the-pack-changed', limit: null, force: false,
      },
    });
    const stale = storedUnit(pack.examples[0]?.id ?? '', 'anything', { score: 0.5, pass: false, details: {} });
    const result = rescoreUnits(run, [stale]);
    expect(result.notes[0]).toContain('changed since this run');
    expect(result.units[0]?.score?.score).toBe(0.5);
    expect(result.pack).toBeNull();
  });

  it('skips re-scoring when the pack directory is gone', () => {
    const run = runRecord({ packDir: '/nonexistent/pack-dir' });
    const result = rescoreUnits(run, []);
    expect(result.notes[0]).toContain('could not be loaded');
    expect(result.pack).toBeNull();
  });
});
