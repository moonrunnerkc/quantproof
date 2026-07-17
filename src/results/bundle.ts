/**
 * Reproducibility bundle: one zip holding the markdown report, every
 * raw model output, all scores, the run metadata (pack hash, digests,
 * sampler params, environment), and the scoring inputs needed to
 * re-score the outputs without the original machine. verifyBundle is
 * the honesty check: it re-scores the raw outputs from the bundle
 * alone and reports any value that no longer matches.
 */

import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { scoreWithGates } from '../scoring/gate-composition.js';
import type { BoundScorer } from '../scoring/gate-composition.js';
import { getScorer } from '../scoring/scorer-registry.js';
import type { LoadedTaskPack } from '../tasks/task-loader.js';
import type { CandidateResult, RunRecord, UnitResult } from './record-types.js';
import { readZip, writeZip } from './zip-archive.js';
import type { ZipEntry } from './zip-archive.js';

/** Everything the bundle builder needs. */
export interface BundleInput {
  readonly run: RunRecord;
  readonly candidates: readonly CandidateResult[];
  readonly units: readonly UnitResult[];
  /** The rendered markdown report, stored verbatim as report.md. */
  readonly markdownReport: string;
  /**
   * The loaded pack, for self-contained re-scoring (scoring.json).
   * Pass null when the pack drifted since the run; the bundle then
   * omits scoring.json and cannot be re-score-verified.
   */
  readonly pack: LoadedTaskPack | null;
}

/** Serialized scoring inputs: enough to re-score outputs offline. */
interface ScoringInputs {
  readonly scorer: string;
  readonly scorerParams: Readonly<Record<string, unknown>>;
  readonly gates: readonly { readonly scorer: string; readonly scorerParams: Readonly<Record<string, unknown>> }[];
  readonly examples: readonly { readonly id: string; readonly expected: unknown }[];
}

/** One row of scores.json. */
interface ScoreRow {
  readonly workUnitId: string;
  readonly candidateId: string;
  readonly exampleId: string;
  readonly repetition: number;
  readonly outputPath: string;
  readonly scorerName: string;
  readonly score: number;
  readonly pass: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function outputPathFor(modelByCandidate: Map<string, string>, unit: UnitResult): string {
  const model = modelByCandidate.get(unit.unit.candidateId) ?? unit.unit.candidateId;
  return `outputs/${sanitize(model)}/${sanitize(unit.unit.exampleId)}-rep${String(unit.unit.repetition)}.txt`;
}

/**
 * Builds the bundle archive for one run.
 *
 * @param input - Run views, rendered report, and the pack (or null).
 * @returns Zip bytes, timestamped with the run's start time so the
 *   same run always exports byte-identical bundles.
 */
export function buildBundle(input: BundleInput): Buffer {
  const modelByCandidate = new Map(
    input.candidates.map((c) => [c.record.id, c.record.modelName]),
  );
  const entries: ZipEntry[] = [
    { path: 'report.md', data: Buffer.from(input.markdownReport, 'utf8') },
    { path: 'run.json', data: json({ run: input.run, candidates: input.candidates }) },
  ];

  const scoreRows: ScoreRow[] = [];
  const unitsMeta: unknown[] = [];
  for (const unit of input.units) {
    const outputPath = unit.generation === null ? null : outputPathFor(modelByCandidate, unit);
    unitsMeta.push({
      ...unit,
      generation: unit.generation === null ? null : { ...unit.generation, output: undefined, outputPath },
    });
    if (unit.generation !== null && outputPath !== null) {
      entries.push({ path: outputPath, data: Buffer.from(unit.generation.output, 'utf8') });
    }
    if (unit.score !== null && outputPath !== null) {
      scoreRows.push({
        workUnitId: unit.unit.id,
        candidateId: unit.unit.candidateId,
        exampleId: unit.unit.exampleId,
        repetition: unit.unit.repetition,
        outputPath,
        scorerName: unit.score.scorerName,
        score: unit.score.score,
        pass: unit.score.pass,
        details: unit.score.details,
      });
    }
  }
  entries.push({ path: 'units.json', data: json(unitsMeta) });
  entries.push({ path: 'scores.json', data: json(scoreRows) });

  if (input.pack !== null) {
    const scoring: ScoringInputs = {
      scorer: input.pack.manifest.scorer,
      scorerParams: input.pack.scorerParams,
      gates: input.pack.gates,
      examples: input.pack.examples.map((e) => ({ id: e.id, expected: e.expected })),
    };
    entries.push({ path: 'scoring.json', data: json(scoring) });
  }
  return writeZip(entries, input.run.createdAtMs);
}

/** Outcome of re-scoring a bundle's raw outputs. */
export interface BundleVerification {
  /** Scores that were recomputed and compared. */
  readonly checked: number;
  /** Human-readable description of every score that changed. */
  readonly mismatches: readonly string[];
}

function entryMap(archive: Buffer): Map<string, Buffer> {
  return new Map(readZip(archive).map((e) => [e.path, e.data]));
}

function requireEntry(entries: Map<string, Buffer>, path: string): Buffer {
  const data = entries.get(path);
  if (data === undefined) {
    throw new Error(
      `bundle is missing ${path}; it was not exported by quantproof report --bundle, or the pack had drifted at export time`,
    );
  }
  return data;
}

/**
 * Re-scores every raw output in a bundle from the bundle's own
 * scoring inputs and compares against the stored scores.
 *
 * @param archive - Bundle zip bytes.
 * @returns Checked count and any mismatches (empty means the bundle's
 *   scores reproduce exactly).
 * @throws Error when the bundle lacks scoring.json, scores.json, or a
 *   referenced output file.
 */
export function verifyBundle(archive: Buffer): BundleVerification {
  registerBuiltinScorers();
  const entries = entryMap(archive);
  const scoring = JSON.parse(requireEntry(entries, 'scoring.json').toString('utf8')) as ScoringInputs;
  const rows = JSON.parse(requireEntry(entries, 'scores.json').toString('utf8')) as ScoreRow[];
  const expectedById = new Map(scoring.examples.map((e) => [e.id, e.expected]));
  const primary: BoundScorer = {
    name: scoring.scorer,
    scorer: getScorer(scoring.scorer),
    params: scoring.scorerParams,
  };
  const gates: BoundScorer[] = scoring.gates.map((g) => ({
    name: g.scorer,
    scorer: getScorer(g.scorer),
    params: g.scorerParams,
  }));

  const mismatches: string[] = [];
  for (const row of rows) {
    const output = requireEntry(entries, row.outputPath).toString('utf8');
    if (!expectedById.has(row.exampleId)) {
      mismatches.push(`${row.outputPath}: example ${row.exampleId} is missing from scoring.json`);
      continue;
    }
    const fresh = scoreWithGates(output, expectedById.get(row.exampleId), primary, gates);
    const stored = { score: row.score, pass: row.pass, details: row.details };
    if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
      mismatches.push(
        `${row.outputPath}: stored score ${String(row.score)} (pass ${String(row.pass)}) but re-scoring produced ${String(fresh.score)} (pass ${String(fresh.pass)})`,
      );
    }
  }
  return { checked: rows.length, mismatches };
}
