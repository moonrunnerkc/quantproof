/**
 * Run config file: the explicit candidate list for a sweep. Shape is
 * deliberately minimal (documented in docs/run-config.md):
 *
 *   candidates:            # models to evaluate, pulled on demand
 *     - gemma3:1b
 *     - qwen3:4b
 *   use_local_models: true # also include everything already pulled
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** A validated run config. */
export interface RunConfig {
  /** Explicit candidate model names, in declared order. */
  readonly candidates: readonly string[];
  /** Whether to merge in every model already in the local store. */
  readonly useLocalModels: boolean;
}

/** The default when no config file is given: sweep the local store. */
export const DEFAULT_RUN_CONFIG: RunConfig = { candidates: [], useLocalModels: true };

/**
 * Loads and validates a run config file.
 *
 * @param path - Path to a YAML config file.
 * @returns The validated config with defaults applied (candidates [],
 *   use_local_models true).
 * @throws Error naming the file and the field to fix when the file is
 *   unreadable, not YAML, or malformed.
 */
export function loadRunConfig(path: string): RunConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `cannot read run config ${path} (${err instanceof Error ? err.message : String(err)}); check the --config path`,
      { cause: err },
    );
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(`${path}: not valid YAML (${err instanceof Error ? err.message : String(err)}); fix the syntax`, {
      cause: err,
    });
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${path}: run config must be a YAML mapping; see docs/run-config.md for the format`);
  }
  const record = doc as Record<string, unknown>;

  const candidatesRaw = record['candidates'] ?? [];
  if (
    !Array.isArray(candidatesRaw) ||
    !candidatesRaw.every((c): c is string => typeof c === 'string' && c.trim() !== '')
  ) {
    throw new Error(`${path}: "candidates" must be a list of model names like "gemma3:1b"; fix it and rerun`);
  }

  const useLocalRaw = record['use_local_models'] ?? true;
  if (typeof useLocalRaw !== 'boolean') {
    throw new Error(`${path}: "use_local_models" must be true or false`);
  }

  const known = new Set(['candidates', 'use_local_models']);
  const unknown = Object.keys(record).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `${path}: unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}; the run config accepts only "candidates" and "use_local_models"`,
    );
  }

  return { candidates: candidatesRaw, useLocalModels: useLocalRaw };
}
