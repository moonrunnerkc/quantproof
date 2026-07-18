/**
 * The ingest command: drafts a runnable task pack from a freeform
 * document using a local model, with bounded repair rounds against the
 * strict draft parser. The flow becomes ingest, run, report. Scoring
 * never involves the drafting model; provenance records it instead.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { BackendAdapter, GenerationRequest } from '../backends/backend-adapter.js';
import { createAdapter } from '../backends/backend-select.js';
import type { ModelInfoSource } from '../catalog/gguf-metadata.js';
import { resolveCandidates } from '../catalog/model-resolver.js';
import { DEFAULT_RUN_CONFIG, loadRunConfig } from '../catalog/run-config.js';
import type { RunConfig } from '../catalog/run-config.js';
import { buildDraftPrompt } from '../ingest/draft-prompt.js';
import type { DraftRepair } from '../ingest/draft-prompt.js';
import { parseDraft, salvageDraft } from '../ingest/draft-parser.js';
import type { PackDraft } from '../ingest/draft-parser.js';
import { writePackDraft } from '../ingest/pack-writer.js';
import { assessCandidates } from '../orchestrator/run-planner.js';
import { registerBuiltinScorers } from '../scoring/builtin-scorers.js';
import { listScorers } from '../scoring/scorer-registry.js';
import { loadTaskPack } from '../tasks/task-loader.js';
import type { PackProvenance } from '../tasks/task-schema.js';
import { observeGeneration } from '../telemetry/timing-probe.js';
import { selectMemoryProbes } from '../telemetry/probe-select.js';
import type { ProbeSelectOptions } from '../telemetry/probe-select.js';

/** Context requested for the drafting generation. */
const DRAFT_CONTEXT = 16384;
/** Token cap for the drafting generation; a full pack is long. */
const DRAFT_MAX_TOKENS = 4096;
/** Total drafting attempts: one draft plus two repair rounds. */
const DRAFT_ATTEMPTS = 3;
/** How much of a failed draft is fed back for repair. */
const REPAIR_DRAFT_CAP = 8000;

/** Options parsed from the command line. */
export interface IngestCommandOptions {
  /** The freeform source document. */
  readonly source: string;
  /** Target pack directory; defaults to ./<drafted-name>. */
  readonly dir?: string;
  /** Drafting model; defaults to the largest local model that fits. */
  readonly model?: string;
  /** Run config choosing the backend; defaults to local Ollama. */
  readonly config?: string;
  readonly baseUrl?: string;
  /** Injectable backend, for tests. */
  readonly adapter?: BackendAdapter;
  /** Probe overrides, for tests. */
  readonly probeOptions?: ProbeSelectOptions;
}

function readSource(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `cannot read ${path}; check the path (the source must be a readable text file)`,
      { cause: err },
    );
  }
}

function isInfoSource(adapter: BackendAdapter): adapter is BackendAdapter & ModelInfoSource {
  return 'showModelInfo' in adapter;
}

async function pickDrafter(
  adapter: BackendAdapter,
  config: RunConfig,
  options: IngestCommandOptions,
): Promise<string> {
  if (options.model !== undefined) {
    return options.model;
  }
  if (config.backend === 'anthropic') {
    const first = config.candidates[0];
    if (first === undefined) {
      throw new Error(
        'the anthropic backend needs a drafting model; pass --model <id> or list candidates in the config',
      );
    }
    return first;
  }
  if (config.backend === 'rapid-mlx') {
    const served = (await adapter.listModels())[0];
    if (served === undefined) {
      throw new Error('the rapid-mlx server serves no model; start it with one loaded, then retry');
    }
    return served.name;
  }
  const resolved = await resolveCandidates(adapter, config);
  if (resolved.candidates.length === 0) {
    throw new Error(
      'no local model to draft with; pull one (ollama pull gemma3:4b) or pass --model',
    );
  }
  if (!isInfoSource(adapter)) {
    const bySize = [...resolved.candidates].sort((a, b) => b.sizeBytes - a.sizeBytes);
    return bySize[0]?.name ?? '';
  }
  const probes = selectMemoryProbes(config.backend, options.probeOptions ?? {});
  const freeMib = probes.sampleOnce()?.freeMib ?? null;
  const assessed = await assessCandidates(adapter, resolved.candidates, DRAFT_CONTEXT, freeMib);
  const fitting = assessed
    .filter((a) => a.fit.verdict === 'fits')
    .sort((a, b) => b.descriptor.sizeBytes - a.descriptor.sizeBytes);
  if (fitting[0] !== undefined) {
    return fitting[0].descriptor.name;
  }
  const smallest = [...assessed].sort((a, b) => a.descriptor.sizeBytes - b.descriptor.sizeBytes)[0];
  if (smallest === undefined) {
    throw new Error('no local model to draft with; pull one (ollama pull gemma3:4b) or pass --model');
  }
  return smallest.descriptor.name;
}

function summarize(draft: PackDraft, dir: string, provenance: PackProvenance): string {
  const paramNote =
    draft.scorer === 'exact-label'
      ? `labels: ${JSON.stringify(draft.scorerParams['labels'])}`
      : draft.scorer === 'field-f1'
        ? `key fields: ${JSON.stringify(draft.scorerParams['key_fields'])}`
        : `scorer_params: ${JSON.stringify(draft.scorerParams)}`;
  return [
    `drafted ${draft.name} (${draft.type}, scorer ${draft.scorer}) in ${dir}:`,
    `  ${String(draft.examples.length)} examples, drafted by ${provenance.drafted_by} from ${provenance.source}`,
    `  ${paramNote}`,
    '',
    'the expected values are model-authored: review examples/ and set',
    'provenance.reviewed: true in task.yaml once they are human-checked.',
    'reports label results from this pack until then.',
    '',
    'next steps:',
    `  1. review (and fix) the examples in ${join(dir, 'examples')}`,
    `  2. quantproof validate ${dir}`,
    `  3. quantproof run --pack ${dir}`,
  ].join('\n');
}

/**
 * Drafts a task pack from a freeform document.
 *
 * @param options - Parsed command options.
 * @returns The absolute pack directory written.
 * @throws When the source is unreadable, no drafting model exists, or
 *   the draft holds no salvageable JSON after all repair rounds; each
 *   error says what to do, and an unsalvageable final draft is kept at
 *   <dir>/draft-response.txt for inspection.
 */
export async function ingestCommand(options: IngestCommandOptions): Promise<string> {
  registerBuiltinScorers();
  const sourceText = readSource(options.source);
  const config = options.config === undefined ? DEFAULT_RUN_CONFIG : loadRunConfig(options.config);
  const adapter = options.adapter ?? createAdapter(config.backend, options.baseUrl);
  const backendVersion = await adapter.version();
  const model = await pickDrafter(adapter, config, options);
  const sourceName = basename(options.source);
  console.log(`drafting from ${sourceName} with ${model} (${backendVersion}); attempts are bounded, this is one generation per attempt`);

  await adapter.ensureModelAvailable(model);
  await adapter.load(model, DRAFT_CONTEXT);
  let repair: DraftRepair | undefined;
  let lastOutput = '';
  let draft: PackDraft | null = null;
  let lastErrors: readonly string[] = [];
  try {
    for (let attempt = 1; attempt <= DRAFT_ATTEMPTS; attempt += 1) {
      const request: GenerationRequest = {
        prompt: buildDraftPrompt(sourceText, sourceName, repair),
        context: DRAFT_CONTEXT,
        maxTokens: DRAFT_MAX_TOKENS,
        temperature: 0,
        seed: 42,
      };
      const observed = await observeGeneration(adapter.generate(model, request));
      lastOutput = observed.summary.output;
      const parsed = parseDraft(lastOutput, listScorers());
      if (parsed.ok) {
        draft = parsed.draft;
        break;
      }
      lastErrors = parsed.errors;
      console.log(`attempt ${String(attempt)}/${String(DRAFT_ATTEMPTS)} failed validation (${String(parsed.errors.length)} problem${parsed.errors.length === 1 ? '' : 's'})${attempt < DRAFT_ATTEMPTS ? '; asking the model to repair' : ''}`);
      repair = { previousDraft: lastOutput.slice(0, REPAIR_DRAFT_CAP), errors: parsed.errors };
    }
  } finally {
    await adapter.unload(model);
  }

  const salvaged = draft ?? salvageDraft(lastOutput, listScorers());
  const dir = resolve(options.dir ?? `./${(salvaged ?? { name: 'drafted-task' }).name}`);
  if (salvaged === null) {
    writeFileSync(`${dir}-draft-response.txt`, lastOutput);
    throw new Error(
      `the drafting model never produced JSON; its last response is at ${dir}-draft-response.txt. Retry with a stronger model: quantproof ingest ${options.source} --model <name>`,
    );
  }
  const provenance: PackProvenance = {
    source: sourceName,
    source_sha256: createHash('sha256').update(sourceText).digest('hex'),
    drafted_by: `${model} (${backendVersion})`,
    drafted_at: new Date().toISOString().slice(0, 10),
    reviewed: false,
  };
  const written = writePackDraft(dir, salvaged, provenance);
  console.log(summarize(salvaged, written.dir, provenance));
  if (draft === null) {
    console.log(
      [
        '',
        `WARNING: the draft failed validation after ${String(DRAFT_ATTEMPTS)} attempts and was written as-is for hand-fixing:`,
        ...lastErrors.map((e) => `  - ${e}`),
      ].join('\n'),
    );
  } else {
    // Self-check: the written pack must survive the strict loader; a
    // failure here is a writer bug, not a user problem, so it throws.
    loadTaskPack(written.dir, listScorers());
  }
  return written.dir;
}
