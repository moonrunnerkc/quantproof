/**
 * Example file loading and validation.
 *
 * One JSON file per example: an object with "input" (string) and
 * "expected" (any JSON value). Validation reads every file and reports
 * every problem in one pass with file paths, never one error per run
 * attempt.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A validated example from a task pack. */
export interface TaskExample {
  /** Stable identifier: the filename without its .json extension. */
  readonly id: string;
  /** Absolute path of the source file, for error reporting downstream. */
  readonly sourcePath: string;
  /** The text substituted into the prompt template. */
  readonly input: string;
  /** The machine-checkable expected result the scorer compares against. */
  readonly expected: unknown;
}

/** Outcome of loading an examples directory. */
export type ExamplesLoad =
  | { readonly ok: true; readonly examples: readonly TaskExample[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Loads and validates every example file in a directory.
 *
 * Files are processed in sorted filename order so example ordering is
 * deterministic across platforms. All validation errors across all
 * files are collected and returned together.
 *
 * @param dir - Absolute path of the examples directory.
 * @returns All examples, or every error found. Errors name the file
 *   and say what to fix. An unreadable directory or a directory with no
 *   .json files is an error. Never throws.
 */
export function loadExamples(dir: string): ExamplesLoad {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `cannot read examples directory ${dir} (${err instanceof Error ? err.message : String(err)}); check examples_dir in task.yaml`,
      ],
    };
  }

  const files = entries.filter((entry) => entry.endsWith('.json')).sort();
  if (files.length === 0) {
    return {
      ok: false,
      errors: [`examples directory ${dir} contains no .json files; add at least one example file like 001.json`],
    };
  }

  const errors: string[] = [];
  const examples: TaskExample[] = [];
  for (const file of files) {
    const sourcePath = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
    } catch (err) {
      errors.push(
        `${sourcePath}: not valid JSON (${err instanceof Error ? err.message : String(err)}); fix the file`,
      );
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push(`${sourcePath}: must be a JSON object with "input" and "expected" keys`);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if ('replace_me' in record) {
      errors.push(
        `${sourcePath}: placeholder example from quantproof init; replace "input" and "expected" with a real example of your task, then delete the "replace_me" key`,
      );
      continue;
    }
    const fileErrors: string[] = [];
    if (typeof record['input'] !== 'string' || record['input'].trim() === '') {
      fileErrors.push(`${sourcePath}: "input" must be a non-empty string`);
    }
    if (!('expected' in record)) {
      fileErrors.push(`${sourcePath}: missing "expected"; add the machine-checkable expected result`);
    }
    if (fileErrors.length > 0) {
      errors.push(...fileErrors);
      continue;
    }
    examples.push({
      id: file.replace(/\.json$/, ''),
      sourcePath,
      input: record['input'] as string,
      expected: record['expected'],
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, examples };
}
