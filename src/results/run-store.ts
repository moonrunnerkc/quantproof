/**
 * SQLite persistence for run results. WAL mode, one database file per
 * project. Every completed generation is journaled in its own
 * transaction on the assumption that the process can die at any
 * moment; a reopened store must always see every unit that finished.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  CandidateOutcome,
  CandidateRecord,
  CandidateResult,
  GenerationRecord,
  RunRecord,
  UnitResult,
  UnitScoreRecord,
  WorkUnitRecord,
} from './record-types.js';
import { candidateFromRow, runFromRow, unitResultFromRows } from './store-rows.js';
import type { UnitRow } from './store-rows.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL,
  pack_name TEXT NOT NULL, pack_dir TEXT NOT NULL, task_type TEXT NOT NULL,
  scorer_name TEXT NOT NULL, generation_json TEXT NOT NULL,
  backend_version TEXT NOT NULL, gpu_name TEXT, driver_version TEXT,
  vram_available INTEGER NOT NULL, vram_unavailable_reason TEXT,
  plan_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  model_name TEXT NOT NULL, digest TEXT NOT NULL,
  quantization TEXT, parameter_size TEXT, size_bytes INTEGER NOT NULL,
  fit_verdict TEXT NOT NULL, predicted_peak_mib REAL, fit_details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', status_reason TEXT,
  peak_vram_mib REAL, vram_samples_json TEXT, deterministic INTEGER,
  offload_suspect_reason TEXT
);
CREATE TABLE IF NOT EXISTS work_units (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  example_id TEXT NOT NULL, repetition INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', failure_reason TEXT
);
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
  output TEXT NOT NULL, done_reason TEXT NOT NULL,
  ttft_ms REAL, tokens_per_second REAL, wall_ms REAL NOT NULL,
  token_count INTEGER NOT NULL, prompt_token_count INTEGER, output_token_count INTEGER,
  request_options_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
  scorer_name TEXT NOT NULL, score REAL NOT NULL, pass INTEGER NOT NULL,
  details_json TEXT NOT NULL
);
`;

/** Open handle on the results database. */
export class RunStore {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Opens (creating if needed) the results database at `dbPath`,
   * applies WAL mode, and ensures the schema exists.
   *
   * @param dbPath - Database file path, e.g. ".quantproof/results.db".
   * @returns An open store. Throws when the path is not writable.
   */
  static open(dbPath: string): RunStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    return new RunStore(db);
  }

  /** Persists a new run row. */
  createRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, created_at_ms, pack_name, pack_dir, task_type, scorer_name,
         generation_json, backend_version, gpu_name, driver_version, vram_available,
         vram_unavailable_reason, plan_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.createdAtMs, run.packName, run.packDir, run.taskType, run.scorerName,
        JSON.stringify(run.generation), run.backendVersion, run.gpuName, run.driverVersion,
        run.vramAvailable ? 1 : 0, run.vramUnavailableReason, JSON.stringify(run.plan),
      );
  }

  /** Persists a candidate row in its initial running state. */
  createCandidate(candidate: CandidateRecord): void {
    this.db
      .prepare(
        `INSERT INTO candidates (id, run_id, model_name, digest, quantization, parameter_size,
         size_bytes, fit_verdict, predicted_peak_mib, fit_details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id, candidate.runId, candidate.modelName, candidate.digest,
        candidate.quantization, candidate.parameterSize, candidate.sizeBytes,
        candidate.fitVerdict, candidate.predictedPeakMib, JSON.stringify(candidate.fitDetails),
      );
  }

  /** Persists the full work plan for a candidate as pending units. */
  createWorkUnits(units: readonly WorkUnitRecord[]): void {
    const insert = this.db.prepare(
      'INSERT INTO work_units (id, run_id, candidate_id, example_id, repetition) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const unit of units) {
        insert.run(unit.id, unit.runId, unit.candidateId, unit.exampleId, unit.repetition);
      }
    })();
  }

  /**
   * Journals one completed generation: unit status, generation record,
   * and score land in a single transaction so a crash can never leave
   * a completed unit without its data or vice versa.
   */
  completeWorkUnit(generation: GenerationRecord, score: UnitScoreRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO generations (id, work_unit_id, output, done_reason, ttft_ms, tokens_per_second,
           wall_ms, token_count, prompt_token_count, output_token_count, request_options_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          generation.id, generation.workUnitId, generation.output, generation.doneReason,
          generation.ttftMs, generation.tokensPerSecond, generation.wallMs, generation.tokenCount,
          generation.promptTokenCount, generation.outputTokenCount,
          JSON.stringify(generation.requestOptions),
        );
      this.db
        .prepare('INSERT INTO scores (id, work_unit_id, scorer_name, score, pass, details_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(score.id, score.workUnitId, score.scorerName, score.score, score.pass ? 1 : 0, JSON.stringify(score.details));
      this.db
        .prepare("UPDATE work_units SET status = 'completed' WHERE id = ?")
        .run(generation.workUnitId);
    })();
  }

  /** Marks a unit failed with the reason; journaled immediately. */
  failWorkUnit(unitId: string, reason: string): void {
    this.db
      .prepare("UPDATE work_units SET status = 'failed', failure_reason = ? WHERE id = ?")
      .run(reason, unitId);
  }

  /**
   * Marks every still-pending unit of a candidate skipped (an OOM
   * candidate's remaining work), in one transaction.
   */
  skipPendingUnits(candidateId: string, reason: string): void {
    this.db
      .prepare("UPDATE work_units SET status = 'skipped', failure_reason = ? WHERE candidate_id = ? AND status = 'pending'")
      .run(reason, candidateId);
  }

  /** Writes a candidate's final measurements and status. */
  finishCandidate(candidateId: string, outcome: CandidateOutcome): void {
    this.db
      .prepare(
        `UPDATE candidates SET status = ?, status_reason = ?, peak_vram_mib = ?,
         vram_samples_json = ?, deterministic = ? WHERE id = ?`,
      )
      .run(
        outcome.status, outcome.statusReason, outcome.peakVramMib, JSON.stringify(outcome.vramSamples),
        outcome.deterministic === null ? null : outcome.deterministic ? 1 : 0, candidateId,
      );
  }

  /** Records that the partial-offload heuristic fired for a candidate. */
  flagOffloadSuspect(candidateId: string, reason: string): void {
    this.db
      .prepare('UPDATE candidates SET offload_suspect_reason = ? WHERE id = ?')
      .run(reason, candidateId);
  }

  /** Reads all runs, newest first. */
  listRuns(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at_ms DESC')
      .all() as Record<string, unknown>[];
    return rows.map(runFromRow);
  }

  /** Reads a run's candidates in insertion order with their outcomes. */
  listCandidates(runId: string): CandidateResult[] {
    const rows = this.db
      .prepare('SELECT * FROM candidates WHERE run_id = ? ORDER BY rowid')
      .all(runId) as Record<string, unknown>[];
    return rows.map(candidateFromRow);
  }

  /**
   * Reads every work unit of a run joined with its generation and
   * score, pending units included; this is the crash-recovery view and
   * the report's input.
   */
  listUnitResults(runId: string): UnitResult[] {
    const units = this.db
      .prepare('SELECT * FROM work_units WHERE run_id = ? ORDER BY candidate_id, example_id, repetition')
      .all(runId) as UnitRow[];
    const generationFor = this.db.prepare('SELECT * FROM generations WHERE work_unit_id = ?');
    const scoreFor = this.db.prepare('SELECT * FROM scores WHERE work_unit_id = ?');
    return units.map((row) =>
      unitResultFromRows(
        row,
        generationFor.get(row.id) as Record<string, unknown> | undefined,
        scoreFor.get(row.id) as Record<string, unknown> | undefined,
      ),
    );
  }

  /** Closes the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
