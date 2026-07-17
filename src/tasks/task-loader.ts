/**
 * Task pack loading: parses and validates a pack directory (task.yaml,
 * prompt template, referenced schema files, examples) into one loaded,
 * ready-to-run structure. Every problem across the whole pack surfaces
 * in a single TaskPackError, never one error per attempt.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateManifest } from './task-schema.js';
import type { TaskManifest } from './task-schema.js';
import { loadExamples } from './example-loader.js';
import type { TaskExample } from './example-loader.js';
import { loadPromptTemplate } from './prompt-template.js';

/** All pack validation problems, aggregated into one throw. */
export class TaskPackError extends Error {
  /** Individual error messages, each naming a file and a fix. */
  readonly problems: readonly string[];

  constructor(packDir: string, problems: readonly string[]) {
    super(
      `task pack ${packDir} has ${String(problems.length)} problem${problems.length === 1 ? '' : 's'}:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'TaskPackError';
    this.problems = problems;
  }
}

/** A fully loaded and validated task pack. */
export interface LoadedTaskPack {
  readonly manifest: TaskManifest;
  /** Prompt template text with the {{input}} placeholder intact. */
  readonly promptTemplate: string;
  readonly examples: readonly TaskExample[];
  /** Primary scorer params with schema paths resolved to objects. */
  readonly scorerParams: Readonly<Record<string, unknown>>;
  /** Gate scorer names with their resolved params, in declared order. */
  readonly gates: readonly {
    readonly scorer: string;
    readonly scorerParams: Readonly<Record<string, unknown>>;
  }[];
}

/**
 * Resolves a manifest-relative path against the pack directory.
 */
function resolvePackPath(packDir: string, declared: string): string {
  return isAbsolute(declared) ? declared : resolve(packDir, declared);
}

/**
 * Replaces a string `schema` param (a path like "./schema.json") with
 * the parsed schema object. Non-string schema params pass through.
 */
function resolveSchemaParam(
  packDir: string,
  params: Readonly<Record<string, unknown>>,
  where: string,
  errors: string[],
): Readonly<Record<string, unknown>> {
  const declared = params['schema'];
  if (typeof declared !== 'string') {
    return params;
  }
  const schemaPath = resolvePackPath(packDir, declared);
  try {
    const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      errors.push(`${schemaPath}: schema file must contain a JSON object; fix ${where}.schema`);
      return params;
    }
    return { ...params, schema };
  } catch (err) {
    errors.push(
      `cannot load schema ${schemaPath} (${err instanceof Error ? err.message : String(err)}); check ${where}.schema in task.yaml`,
    );
    return params;
  }
}

/**
 * Loads a task pack directory into a validated, ready-to-run pack.
 *
 * @param packDir - Path of the pack directory containing task.yaml.
 * @param knownScorers - Registered scorer names, used to validate the
 *   manifest's scorer references.
 * @returns The loaded pack: manifest, prompt template, examples, and
 *   scorer params with schema file references resolved to objects.
 * @throws TaskPackError listing every problem found across task.yaml,
 *   the prompt template, schema files, and all example files.
 */
export function loadTaskPack(packDir: string, knownScorers: readonly string[]): LoadedTaskPack {
  const absDir = resolve(packDir);
  const manifestPath = join(absDir, 'task.yaml');

  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new TaskPackError(absDir, [
      `cannot read ${manifestPath} (${err instanceof Error ? err.message : String(err)}); create a task.yaml, or run quantproof init to scaffold one`,
    ]);
  }

  let rawDoc: unknown;
  try {
    rawDoc = parseYaml(rawText);
  } catch (err) {
    throw new TaskPackError(absDir, [
      `${manifestPath}: not valid YAML (${err instanceof Error ? err.message : String(err)}); fix the syntax`,
    ]);
  }

  const validation = validateManifest(rawDoc, knownScorers);
  if (!validation.ok) {
    throw new TaskPackError(
      absDir,
      validation.errors.map((e) => `${manifestPath}: ${e}`),
    );
  }
  const manifest = validation.manifest;

  const errors: string[] = [];

  const templateResult = loadPromptTemplate(resolvePackPath(absDir, manifest.prompt_template));
  if (!templateResult.ok) {
    errors.push(templateResult.error);
  }

  const scorerParams = resolveSchemaParam(absDir, manifest.scorer_params, 'scorer_params', errors);
  const gates = manifest.gates.map((gate, index) => ({
    scorer: gate.scorer,
    scorerParams: resolveSchemaParam(
      absDir,
      gate.scorer_params,
      `gates[${String(index)}].scorer_params`,
      errors,
    ),
  }));

  const examplesResult = loadExamples(resolvePackPath(absDir, manifest.examples_dir));
  if (!examplesResult.ok) {
    errors.push(...examplesResult.errors);
  }

  if (errors.length > 0 || !templateResult.ok || !examplesResult.ok) {
    throw new TaskPackError(absDir, errors);
  }

  return {
    manifest,
    promptTemplate: templateResult.template,
    examples: examplesResult.examples,
    scorerParams,
    gates,
  };
}
