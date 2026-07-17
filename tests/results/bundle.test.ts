import { describe, expect, it } from 'vitest';
import { buildBundle, verifyBundle } from '../../src/results/bundle.js';
import { readZip, writeZip } from '../../src/results/zip-archive.js';
import { scoreWithGates } from '../../src/scoring/gate-composition.js';
import type { UnitResult } from '../../src/results/record-types.js';
import { loadStarterPack } from '../helpers/starter-packs.js';
import { candidateResult, runRecord } from '../report/report-fixtures.js';

const { pack, primary, gates } = loadStarterPack('ticket-classification');

/** A unit whose stored score really came from scoring its output. */
function scoredUnit(exampleId: string, repetition: number, output: string): UnitResult {
  const record = scoreWithGates(output, pack.examples.find((e) => e.id === exampleId)?.expected, primary, gates);
  const id = `u-${exampleId}-${String(repetition)}`;
  return {
    unit: { id, runId: 'run-1', candidateId: 'c1', exampleId, repetition },
    status: 'completed',
    failureReason: null,
    generation: {
      id: `g-${id}`, workUnitId: id, output, doneReason: 'stop',
      ttftMs: 120, tokensPerSecond: 30, wallMs: 400, tokenCount: 4,
      promptTokenCount: 50, outputTokenCount: 4,
      requestOptions: { num_ctx: 2048, seed: 42, temperature: 0 },
    },
    score: {
      id: `s-${id}`, workUnitId: id, scorerName: pack.manifest.scorer,
      score: record.score, pass: record.pass,
      details: JSON.parse(JSON.stringify(record.details)) as Record<string, unknown>,
    },
  };
}

function realisticBundle(): Buffer {
  const first = pack.examples[0];
  const second = pack.examples[1];
  if (first === undefined || second === undefined) {
    throw new Error('ticket-classification pack lost its examples; restore examples/ticket-classification');
  }
  const units = [
    scoredUnit(first.id, 1, String(first.expected)),
    scoredUnit(first.id, 2, String(first.expected)),
    scoredUnit(second.id, 1, 'not a valid label'),
  ];
  return buildBundle({
    run: runRecord({ packName: pack.manifest.name }),
    candidates: [candidateResult('c1', 'gemma3:1b')],
    units,
    markdownReport: '# report placeholder\n',
    pack,
  });
}

describe('buildBundle', () => {
  it('contains report, run metadata, outputs, scores, and scoring inputs', () => {
    const paths = readZip(realisticBundle()).map((e) => e.path);
    expect(paths).toContain('report.md');
    expect(paths).toContain('run.json');
    expect(paths).toContain('units.json');
    expect(paths).toContain('scores.json');
    expect(paths).toContain('scoring.json');
    expect(paths.filter((p) => p.startsWith('outputs/gemma3-1b/'))).toHaveLength(3);
  });

  it('stores raw outputs verbatim and strips them from units.json', () => {
    const entries = new Map(readZip(realisticBundle()).map((e) => [e.path, e.data]));
    const first = pack.examples[0];
    const output = entries.get(`outputs/gemma3-1b/${first?.id ?? ''}-rep1.txt`);
    expect(output?.toString('utf8')).toBe(String(first?.expected));
    const unitsJson = entries.get('units.json')?.toString('utf8') ?? '';
    expect(unitsJson).toContain('"outputPath"');
    expect(unitsJson).not.toContain('"output":');
  });

  it('carries the pack hash and environment inside run.json', () => {
    const entries = new Map(readZip(realisticBundle()).map((e) => [e.path, e.data]));
    const run = JSON.parse(entries.get('run.json')?.toString('utf8') ?? '{}') as {
      run: { plan: { packFingerprint: string }; backendVersion: string };
      candidates: { record: { digest: string } }[];
    };
    expect(run.run.plan.packFingerprint).toBe('pack-fp');
    expect(run.run.backendVersion).toBe('ollama 0.23.1');
    expect(run.candidates[0]?.record.digest).toContain('c1-digest');
  });

  it('omits scoring.json when the pack is unavailable', () => {
    const bundle = buildBundle({
      run: runRecord(),
      candidates: [candidateResult('c1', 'gemma3:1b')],
      units: [],
      markdownReport: '# r\n',
      pack: null,
    });
    expect(readZip(bundle).map((e) => e.path)).not.toContain('scoring.json');
  });
});

describe('verifyBundle', () => {
  it('re-scores every raw output to the stored values', () => {
    const verification = verifyBundle(realisticBundle());
    expect(verification.checked).toBe(3);
    expect(verification.mismatches).toEqual([]);
  });

  it('reports a score that no longer matches its raw output', () => {
    const entries = readZip(realisticBundle());
    const tampered = entries.map((entry) => {
      if (entry.path !== 'scores.json') {
        return entry;
      }
      const rows = JSON.parse(entry.data.toString('utf8')) as { score: number; pass: boolean }[];
      const first = rows[0] as { score: number; pass: boolean };
      first.score = 0.123;
      return { path: entry.path, data: Buffer.from(JSON.stringify(rows, null, 2)) };
    });
    const verification = verifyBundle(writeZip(tampered, Date.UTC(2026, 6, 16)));
    expect(verification.mismatches).toHaveLength(1);
    expect(verification.mismatches[0]).toContain('stored score 0.123');
  });

  it('fails loudly on a bundle without scoring inputs', () => {
    const bundle = buildBundle({
      run: runRecord(),
      candidates: [],
      units: [],
      markdownReport: '# r\n',
      pack: null,
    });
    expect(() => verifyBundle(bundle)).toThrow(/missing scoring\.json/);
  });
});
