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
  GenerationRecord,
  RunRecord,
  UnitResult,
  UnitScoreRecord,
  WorkUnitRecord,
  WorkUnitStatus,
} from './record-types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL,
  pack_name TEXT NOT NULL, pack_dir TEXT NOT NULL, task_type TEXT NOT NULL,
  scorer_name TEXT NOT NULL, generation_json TEXT NOT NULL,
  backend_version TEXT NOT NULL, gpu_name TEXT, driver_version TEXT,
  vram_available INTEGER NOT NULL, vram_unavailable_reason TEXT
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  model_name TEXT NOT NULL, digest TEXT NOT NULL,
  quantization TEXT, parameter_size TEXT, size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  peak_vram_mib REAL, vram_samples_json TEXT, deterministic INTEGER
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

interface UnitRow {
  id: string;
  run_id: string;
  candidate_id: string;
  example_id: string;
  repetition: number;
  status: WorkUnitStatus;
  failure_reason: string | null;
}

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
         generation_json, backend_version, gpu_name, driver_version, vram_available, vram_unavailable_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.createdAtMs, run.packName, run.packDir, run.taskType, run.scorerName,
        JSON.stringify(run.generation), run.backendVersion, run.gpuName, run.driverVersion,
        run.vramAvailable ? 1 : 0, run.vramUnavailableReason,
      );
  }

  /** Persists a candidate row in its initial running state. */
  createCandidate(candidate: CandidateRecord): void {
    this.db
      .prepare(
        `INSERT INTO candidates (id, run_id, model_name, digest, quantization, parameter_size, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id, candidate.runId, candidate.modelName, candidate.digest,
        candidate.quantization, candidate.parameterSize, candidate.sizeBytes,
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

  /** Writes a candidate's final measurements and status. */
  finishCandidate(candidateId: string, outcome: CandidateOutcome): void {
    this.db
      .prepare(
        'UPDATE candidates SET status = ?, peak_vram_mib = ?, vram_samples_json = ?, deterministic = ? WHERE id = ?',
      )
      .run(
        outcome.status, outcome.peakVramMib, JSON.stringify(outcome.vramSamples),
        outcome.deterministic === null ? null : outcome.deterministic ? 1 : 0, candidateId,
      );
  }

  /** Reads all runs, newest first. */
  listRuns(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at_ms DESC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row['id'] as string,
      createdAtMs: row['created_at_ms'] as number,
      packName: row['pack_name'] as string,
      packDir: row['pack_dir'] as string,
      taskType: row['task_type'] as string,
      scorerName: row['scorer_name'] as string,
      generation: JSON.parse(row['generation_json'] as string) as RunRecord['generation'],
      backendVersion: row['backend_version'] as string,
      gpuName: row['gpu_name'] as string | null,
      driverVersion: row['driver_version'] as string | null,
      vramAvailable: row['vram_available'] === 1,
      vramUnavailableReason: row['vram_unavailable_reason'] as string | null,
    }));
  }

  /**
   * Reads every work unit of a run joined with its generation and
   * score, pending units included; this is the crash-recovery view and
   * the report's input.
   */
  listUnitResults(runId: string): UnitResult[] {
    const units = this.db
      .prepare('SELECT * FROM work_units WHERE run_id = ? ORDER BY example_id, repetition')
      .all(runId) as UnitRow[];
    const generationFor = this.db.prepare('SELECT * FROM generations WHERE work_unit_id = ?');
    const scoreFor = this.db.prepare('SELECT * FROM scores WHERE work_unit_id = ?');
    return units.map((row) => {
      const gen = generationFor.get(row.id) as Record<string, unknown> | undefined;
      const score = scoreFor.get(row.id) as Record<string, unknown> | undefined;
      return {
        unit: {
          id: row.id, runId: row.run_id, candidateId: row.candidate_id,
          exampleId: row.example_id, repetition: row.repetition,
        },
        status: row.status,
        failureReason: row.failure_reason,
        generation: gen === undefined ? null : {
          id: gen['id'] as string, workUnitId: row.id, output: gen['output'] as string,
          doneReason: gen['done_reason'] as string, ttftMs: gen['ttft_ms'] as number | null,
          tokensPerSecond: gen['tokens_per_second'] as number | null, wallMs: gen['wall_ms'] as number,
          tokenCount: gen['token_count'] as number, promptTokenCount: gen['prompt_token_count'] as number | null,
          outputTokenCount: gen['output_token_count'] as number | null,
          requestOptions: JSON.parse(gen['request_options_json'] as string) as Record<string, unknown>,
        },
        score: score === undefined ? null : {
          id: score['id'] as string, workUnitId: row.id, scorerName: score['scorer_name'] as string,
          score: score['score'] as number, pass: score['pass'] === 1,
          details: JSON.parse(score['details_json'] as string) as Record<string, unknown>,
        },
      };
    });
  }

  /** Closes the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
