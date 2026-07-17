/**
 * The init command: interactive scaffold for a new task pack. Every
 * prompt states its default, every generated file says what to edit,
 * and the two placeholder examples fail validation on purpose so a
 * scaffolded pack cannot be swept until real examples exist.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import {
  examplePlaceholder,
  promptTemplate,
  scaffoldedScorers,
  schemaTemplate,
  taskYamlTemplate,
} from './init-templates.js';

/** Answers a prompt; the CLI wires readline, tests wire a script. */
export type Ask = (question: string, defaultValue: string) => Promise<string>;

/** Options parsed from the command line (or injected by tests). */
export interface InitCommandOptions {
  /** Target directory; defaults to ./<name>. */
  readonly dir?: string;
  readonly name?: string;
  readonly type?: string;
  readonly scorer?: string;
  /** Accept every default without prompting. */
  readonly yes?: boolean;
  /** Prompt implementation override. */
  readonly ask?: Ask;
}

async function readlineAsk(question: string, defaultValue: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [${defaultValue}]: `)).trim();
    return answer === '' ? defaultValue : answer;
  } finally {
    rl.close();
  }
}

const acceptDefaults: Ask = (_question, defaultValue) => Promise.resolve(defaultValue);

/**
 * Scaffolds a new task pack directory.
 *
 * @param options - Flags and an optional prompt override; missing
 *   answers are prompted for interactively (defaults apply with --yes
 *   or when stdin is not a terminal).
 * @returns The created pack directory (absolute).
 * @throws Error when the target already contains a task.yaml or the
 *   chosen scorer has no scaffold; both name the fix.
 */
export async function initCommand(options: InitCommandOptions): Promise<string> {
  registerBuiltinScorers();
  const interactive = options.yes !== true && process.stdin.isTTY === true;
  const ask = options.ask ?? (interactive ? readlineAsk : acceptDefaults);

  const defaultName = options.dir === undefined ? 'my-task' : basename(resolve(options.dir));
  const name = options.name ?? (await ask('task name', defaultName));
  const type = options.type ?? (await ask('task type (extraction | classification | generation)', 'extraction'));
  const scorers = scaffoldedScorers();
  const scorer = options.scorer ?? (await ask(`scorer (${scorers.join(' | ')})`, 'field-f1'));
  if (!scorers.includes(scorer)) {
    throw new Error(`scorer "${scorer}" has no init scaffold; use one of: ${scorers.join(', ')}`);
  }

  const dir = resolve(options.dir ?? `./${name}`);
  if (existsSync(join(dir, 'task.yaml'))) {
    throw new Error(
      `${dir} already contains a task.yaml; init never overwrites a pack, pick a new directory or edit the existing pack`,
    );
  }
  mkdirSync(join(dir, 'examples'), { recursive: true });

  const files: { path: string; content: string; edit: string }[] = [
    { path: join(dir, 'task.yaml'), content: taskYamlTemplate(name, type, scorer), edit: 'scorer params and generation settings' },
    { path: join(dir, 'prompt.md'), content: promptTemplate(scorer), edit: 'replace the instruction lines with your real prompt' },
    { path: join(dir, 'examples', '001-replace-me.json'), content: examplePlaceholder(scorer), edit: 'replace with a real example' },
    { path: join(dir, 'examples', '002-replace-me.json'), content: examplePlaceholder(scorer), edit: 'replace with a real example' },
  ];
  const schema = schemaTemplate(scorer);
  if (schema !== null) {
    files.splice(2, 0, { path: join(dir, 'schema.json'), content: `${schema}\n`, edit: 'declare the exact output shape' });
  }
  for (const file of files) {
    writeFileSync(file.path, file.content);
  }

  const lines = [
    `scaffolded ${name} (${type}, scorer ${scorer}) in ${dir}:`,
    ...files.map((f) => `  ${f.path.slice(dir.length + 1).padEnd(28)} ${f.edit}`),
    '',
    'next steps:',
    '  1. replace the two placeholder examples (20 to 50 real examples make results meaningful)',
    `  2. quantproof validate ${dir}`,
    `  3. quantproof run --pack ${dir}`,
  ];
  console.log(lines.join('\n'));
  return dir;
}
