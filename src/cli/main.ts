#!/usr/bin/env node
/**
 * CLI entry point. Command routing only; each command lives in its own
 * module as phases land. Phase 0 ships validation of task packs; run,
 * resume, report, and models arrive with the executor in phase 1+.
 */

import { Command } from 'commander';
import { initCommand } from './command-init.js';
import { modelsCommand } from './command-models.js';
import { reportCommand } from './command-report.js';
import { resumeCommand } from './command-resume.js';
import { runCommand } from './command-run.js';
import { journalFailureHint } from '../results/run-store.js';
import { checkExpectedValues } from '../scoring/plan-check.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { listScorers } from '../scoring/scorer-registry.js';
import { loadTaskPack, TaskPackError } from '../tasks/task-loader.js';

registerBuiltinScorers();

const program = new Command();

program
  .name('quantproof')
  .description(
    'Runs your real task examples against local quantized models via Ollama and recommends the smallest quant that holds quality.',
  )
  .version('0.1.0');

program
  .command('validate')
  .description('Validate a task pack directory without running anything')
  .argument('<pack-dir>', 'path to a task pack directory containing task.yaml')
  .action((packDir: string) => {
    try {
      const pack = loadTaskPack(packDir, listScorers());
      const authoringProblems = checkExpectedValues(pack);
      if (authoringProblems.length > 0) {
        throw new TaskPackError(packDir, authoringProblems);
      }
      console.log(
        `task pack "${pack.manifest.name}" is valid: ${String(pack.examples.length)} examples, scorer ${pack.manifest.scorer}` +
          (pack.gates.length > 0 ? `, gates: ${pack.gates.map((g) => g.scorer).join(', ')}` : ''),
      );
    } catch (err) {
      if (err instanceof TaskPackError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program
  .command('run')
  .description('Sweep candidate models over a task pack and print measured result tables')
  .requiredOption('--pack <dir>', 'task pack directory')
  .option('--model <name>', 'run exactly one model, e.g. gemma3:1b')
  .option('--config <file>', 'run config file listing candidate models')
  .option('--force', 'attempt candidates predicted not to fit')
  .option('--db <path>', 'results database path', '.quantproof/results.db')
  .option('--limit <n>', 'run only the first N examples', (v) => Number.parseInt(v, 10))
  .action(async (options: { pack: string; model?: string; config?: string; force?: boolean; db: string; limit?: number }) => {
    try {
      await runCommand(options);
    } catch (err) {
      const hint = journalFailureHint(err, options.db);
      console.error(hint?.message ?? (err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command('resume')
  .description('Resume the newest incomplete run from the journal')
  .option('--db <path>', 'results database path', '.quantproof/results.db')
  .action(async (options: { db: string }) => {
    try {
      await resumeCommand(options);
    } catch (err) {
      const hint = journalFailureHint(err, options.db);
      console.error(hint?.message ?? (err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Scaffold a new task pack interactively')
  .argument('[dir]', 'target directory; defaults to ./<task-name>')
  .option('--name <name>', 'task pack name')
  .option('--type <type>', 'task type, e.g. extraction or classification')
  .option('--scorer <scorer>', 'primary scorer for the scaffold')
  .option('--yes', 'accept every default without prompting')
  .action(async (dir: string | undefined, options: { name?: string; type?: string; scorer?: string; yes?: boolean }) => {
    try {
      await initCommand({ ...options, ...(dir === undefined ? {} : { dir }) });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('models')
  .description('List candidate models with sizes, quant tags, and fit predictions')
  .option('--config <file>', 'run config file listing candidate models')
  .option('--context <n>', 'context length for the fit prediction (default 4096)', (v) => Number.parseInt(v, 10))
  .option('--backend <name>', 'backend to list: ollama (default), rapid-mlx, or anthropic', (v) => {
    if (v !== 'ollama' && v !== 'rapid-mlx' && v !== 'anthropic') {
      throw new Error(`--backend must be "ollama", "rapid-mlx", or "anthropic", got "${v}"`);
    }
    return v;
  })
  .action(async (options: { config?: string; context?: number; backend?: 'ollama' | 'rapid-mlx' | 'anthropic' }) => {
    try {
      await modelsCommand(options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('report')
  .description('Render a stored run as a comparison table, a markdown report, or a reproducibility bundle')
  .argument('[run-id]', 'run id (a unique prefix works); the newest run when omitted')
  .option('--db <path>', 'results database path', '.quantproof/results.db')
  .option('--markdown', 'write the shareable markdown report to a file')
  .option('--bundle', 'export the reproducibility bundle (report, raw outputs, scores, metadata)')
  .option('--out <path>', 'output file path for --markdown or --bundle')
  .option('--tolerance <fraction>', 'quality tolerance for the recommendation, e.g. 0.02', (v) => Number.parseFloat(v))
  .action((runId: string | undefined, options: { db: string; markdown?: boolean; bundle?: boolean; out?: string; tolerance?: number }) => {
    try {
      reportCommand({ ...options, ...(runId === undefined ? {} : { runId }) });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.parse();
