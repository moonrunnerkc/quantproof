/**
 * Writes a checked pack draft to disk as a normal task pack: the same
 * files a hand-written pack has, plus the provenance block that records
 * who drafted it. The output must survive the strict loader untouched;
 * the ingest command re-validates with loadTaskPack right after
 * writing.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { PackProvenance } from '../tasks/task-schema.js';
import type { PackDraft } from './draft-parser.js';

/** Generation defaults for drafted packs, same as init scaffolds. */
const GENERATION_DEFAULTS = {
  context: 4096,
  max_tokens: 512,
  temperature: 0,
  seed: 42,
  runs_per_example: 3,
} as const;

const MANIFEST_HEADER = `# Task pack drafted by quantproof ingest. Format spec: docs/task-packs.md.
# The provenance block records the drafting model; review the examples
# and set provenance.reviewed to true once they are human-checked.
`;

/** Where a draft landed on disk. */
export interface WrittenPack {
  /** Absolute pack directory. */
  readonly dir: string;
  /** Files written, relative to the pack directory. */
  readonly files: readonly string[];
}

/**
 * Checks that a directory is safe to receive a fresh pack draft.
 *
 * @param targetDir - Pack directory a draft would be written into.
 * @throws When the directory exists and holds any file: writing there
 *   would merge stale files (leftover examples included) into the new
 *   draft, so pick another directory or delete this one first.
 */
export function assertPackTargetWritable(targetDir: string): void {
  const dir = resolve(targetDir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(
      `${dir} already exists and is not empty; ingest never overwrites or merges into an existing directory, so pick another directory or delete it first (rm -r ${dir})`,
    );
  }
}

/**
 * Writes a pack draft and its provenance as a task pack directory.
 *
 * @param targetDir - Pack directory to create; resolved to absolute.
 * @param draft - The checked draft from parseDraft.
 * @param provenance - Drafting provenance recorded in task.yaml.
 * @returns The absolute directory and the files written.
 * @throws When the directory exists non-empty (stale files, a prior
 *   pack); pick another directory or delete it first.
 */
export function writePackDraft(
  targetDir: string,
  draft: PackDraft,
  provenance: PackProvenance,
): WrittenPack {
  const dir = resolve(targetDir);
  assertPackTargetWritable(dir);
  mkdirSync(join(dir, 'examples'), { recursive: true });

  const manifest = {
    name: draft.name,
    type: draft.type,
    scorer: draft.scorer,
    ...(Object.keys(draft.scorerParams).length > 0 ? { scorer_params: draft.scorerParams } : {}),
    generation: GENERATION_DEFAULTS,
    prompt_template: './prompt.md',
    examples_dir: './examples',
    provenance,
  };
  const files: string[] = [];
  const write = (relative: string, content: string): void => {
    writeFileSync(join(dir, relative), content);
    files.push(relative);
  };
  write('task.yaml', MANIFEST_HEADER + stringify(manifest));
  write('prompt.md', draft.prompt.endsWith('\n') ? draft.prompt : `${draft.prompt}\n`);
  const width = Math.max(3, String(draft.examples.length).length);
  draft.examples.forEach((example, index) => {
    const id = String(index + 1).padStart(width, '0');
    write(join('examples', `${id}.json`), `${JSON.stringify(example, null, 2)}\n`);
  });
  return { dir, files };
}
