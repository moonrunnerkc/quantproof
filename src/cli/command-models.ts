/**
 * The models command: what a sweep would consider, before spending any
 * inference time. Lists every candidate (local store plus config
 * candidates) with size, quant tag, and the fit prediction at a chosen
 * context length, so users can sanity-check the ladder first.
 */

import { AnthropicAdapter } from '../backends/anthropic-adapter.js';
import { OllamaAdapter } from '../backends/ollama-adapter.js';
import type { BackendAdapter } from '../backends/backend-adapter.js';
import type { BackendKind } from '../catalog/run-config.js';
import { DEFAULT_RUN_CONFIG, loadRunConfig } from '../catalog/run-config.js';
import type { ModelInfoSource } from '../catalog/gguf-metadata.js';
import { resolveCandidates } from '../catalog/model-resolver.js';
import { assessCandidates } from '../orchestrator/run-planner.js';
import { fmtMib, renderColumns, wrapLine } from '../report/format.js';
import { selectMemoryProbes } from '../telemetry/probe-select.js';

/** Options parsed from the command line. */
export interface ModelsCommandOptions {
  /** Run config file with explicit candidates. */
  readonly config?: string;
  /** Context length for the fit prediction; default 4096. */
  readonly context?: number;
  /** Backend to list; default ollama. */
  readonly backend?: BackendKind;
  readonly baseUrl?: string;
  /** Injectable backend, for tests; defaults to the Ollama adapter. */
  readonly adapter?: BackendAdapter & ModelInfoSource;
}

const DEFAULT_PREVIEW_CONTEXT = 4096;

async function listAnthropicModels(baseUrl?: string): Promise<string> {
  const adapter = new AnthropicAdapter(baseUrl);
  const backendVersion = await adapter.version();
  const models = await adapter.listModels();
  const lines = [
    `${String(models.length)} model${models.length === 1 ? '' : 's'} | ${backendVersion}`,
    'inference runs on Anthropic hardware; local fit and VRAM do not apply to this backend',
    '',
    ...models.map((m) => `  ${m.name}`),
    '',
    'sweep them by listing ids in a config file: backend: anthropic, candidates: [<id>, ...]',
  ];
  const text = lines.join('\n');
  console.log(text);
  return text;
}

/**
 * Lists candidates with fit predictions.
 *
 * @param options - Parsed command options.
 * @returns The rendered listing (also printed).
 * @throws When the backend is unreachable or the config file is
 *   invalid; both errors carry the fix.
 */
export async function modelsCommand(options: ModelsCommandOptions): Promise<string> {
  if (options.backend === 'anthropic') {
    return listAnthropicModels(options.baseUrl);
  }
  const adapter = options.adapter ?? new OllamaAdapter(options.baseUrl);
  const backendVersion = await adapter.version();
  const config = options.config === undefined ? DEFAULT_RUN_CONFIG : loadRunConfig(options.config);
  const resolved = await resolveCandidates(adapter, config);
  const context = options.context ?? DEFAULT_PREVIEW_CONTEXT;
  const probes = selectMemoryProbes('ollama');
  const freeVramMib = probes.sampleOnce()?.freeMib ?? null;
  const assessments = await assessCandidates(adapter, resolved.candidates, context, freeVramMib);

  const lines: string[] = [
    `${String(assessments.length)} candidate${assessments.length === 1 ? '' : 's'} | ${backendVersion} | ` +
      (freeVramMib === null
        ? 'free memory not measurable (no nvidia-smi, not Apple Silicon macOS), so fit verdicts are "unknown" and a sweep will attempt every candidate'
        : `${fmtMib(freeVramMib)} MiB free for models${probes.source === 'unified-memory' ? ' (75% unified-memory budget minus resident backend memory)' : ''}`),
    `fit predicted at context ${String(context)}; a sweep uses each pack's declared context (preview another with --context)`,
    '',
  ];
  lines.push(
    ...renderColumns(
      ['model', 'quant', 'params', 'weights MiB', 'predicted peak MiB', 'fit'],
      assessments.map(({ descriptor, fit }) => [
        descriptor.name,
        descriptor.quantization ?? '?',
        descriptor.parameterSize ?? '?',
        fmtMib(descriptor.sizeBytes / (1024 * 1024)),
        fit.predictedPeakMib === null ? '?' : fmtMib(fit.predictedPeakMib),
        fit.verdict,
      ]),
      [3, 4],
    ),
  );
  for (const { descriptor, fit } of assessments) {
    if (fit.verdict !== 'fits') {
      lines.push(...wrapLine(`  ${descriptor.name}: ${fit.reason}`));
    }
  }
  if (resolved.excluded.length > 0) {
    lines.push('');
    for (const excluded of resolved.excluded) {
      lines.push(...wrapLine(`excluded ${excluded.name}: ${excluded.reason}`));
    }
  }
  if (assessments.length === 0) {
    lines.push('no local candidates; pull one (ollama pull gemma3:1b) or list candidates in a --config file');
  }
  const text = lines.join('\n');
  console.log(text);
  return text;
}
