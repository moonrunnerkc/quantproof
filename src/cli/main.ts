#!/usr/bin/env node
/**
 * CLI entry point. Command routing only; each command lives in its own
 * module as phases land. Phase 0 ships validation of task packs; run,
 * resume, report, and models arrive with the executor in phase 1+.
 */

import { Command } from 'commander';
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

program.parse();
