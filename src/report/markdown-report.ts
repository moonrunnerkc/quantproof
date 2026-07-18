/**
 * The shareable markdown report: this exact file is the launch
 * artifact people post, so layout follows build plan 5.8 (title,
 * environment, results, Pareto, recommendation, methodology,
 * reproduction) and every number goes through the shared terse
 * formatters. Flags render as lettered footnotes under the table.
 */

import type { CandidateAggregate } from './aggregate.js';
import { fmtMib, fmtMs, fmtRate, fmtScore, fmtSignedPercent, fmtWithSpread, provenanceLabel } from './format.js';
import type { ReportData } from './report-data.js';
import { isApiBackend } from '../backends/backend-select.js';
import type { RunRecord } from '../results/record-types.js';

/**
 * Rebuilds the exact command that produced a run from its plan
 * snapshot.
 *
 * @param run - The run record.
 * @returns e.g. "quantproof run --pack examples/invoice-extraction --limit 3".
 */
export function reproductionCommand(run: RunRecord): string {
  const parts = [`quantproof run --pack ${run.packDir}`];
  if (run.plan.explicitModel !== null) {
    parts.push(`--model ${run.plan.explicitModel}`);
  }
  if (run.plan.configPath !== null) {
    parts.push(`--config ${run.plan.configPath}`);
  }
  if (run.plan.limit !== null) {
    parts.push(`--limit ${String(run.plan.limit)}`);
  }
  if (run.plan.force && run.plan.explicitModel === null) {
    parts.push('--force');
  }
  return parts.join(' ');
}

function memorySentence(run: RunRecord): string {
  if (run.gpuName === null) {
    return `Memory was not measured (${run.vramUnavailableReason ?? 'no memory telemetry on this machine'}).`;
  }
  const method = run.gpuName.includes('unified memory')
    ? 'resident backend process memory on Apple Silicon'
    : run.gpuName === 'system RAM'
      ? 'resident backend process memory against system RAM, CPU inference'
      : 'GPU memory via nvidia-smi';
  return `Memory is polled during load and generation (${method}); the peak is the highest sample.`;
}

interface Footnote {
  readonly marker: string;
  readonly text: string;
}

function footnotesFor(aggregates: readonly CandidateAggregate[]): Map<CandidateAggregate, Footnote[]> {
  const notes = new Map<CandidateAggregate, Footnote[]>();
  let index = 0;
  const marker = (): string => `[${String.fromCharCode(97 + index++)}]`;
  for (const aggregate of aggregates) {
    const own: Footnote[] = [];
    if (aggregate.status === 'oom') {
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: ${aggregate.statusReason ?? 'out of memory'}` });
    }
    if (aggregate.status === 'failed') {
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: FAILED, ${aggregate.statusReason ?? 'no reason recorded'}` });
    }
    if (aggregate.status === 'running') {
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: interrupted before finishing; quantproof resume will complete its pending units` });
    }
    if (aggregate.gatesPassed === false) {
      const gates = Object.entries(aggregate.gateFailureCounts)
        .map(([gate, count]) => `${gate} on ${String(count)} of ${String(aggregate.summary.completed)} completed units`)
        .join('; ');
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: failed gate scorers (${gates}); gate failures zero the unit score and exclude the candidate from the frontier and the recommendation` });
    }
    if (aggregate.summary.truncatedEmptyCount > 0) {
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: ${String(aggregate.summary.truncatedEmptyCount)} of ${String(aggregate.summary.completed)} completed units hit the max_tokens budget before emitting any visible output; those scores measure truncation, not task quality; raise generation.max_tokens in task.yaml` });
    }
    if (aggregate.offloadSuspectReason !== null) {
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: suspected CPU/GPU split, ${aggregate.offloadSuspectReason}` });
    }
    if (aggregate.summary.outputsDeterministic === false) {
      own.push({ marker: marker(), text: `${aggregate.candidate.modelName}: outputs differed across repetitions; the backend did not produce repeatable output for identical requests` });
    }
    notes.set(aggregate, own);
  }
  return notes;
}

function resultsRow(aggregate: CandidateAggregate, footnotes: readonly Footnote[]): string {
  const s = aggregate.summary;
  const quality = fmtWithSpread(s.meanScore, s.scoreSpread, fmtScore);
  const pass = s.passRate === null ? '-' : `${(s.passRate * 100).toFixed(1)}%`;
  const ttft = fmtWithSpread(s.ttftMedianMs, s.ttftSpreadMs, fmtMs);
  const rate = fmtWithSpread(s.tokensPerSecondMedian, s.tokensPerSecondSpread, fmtRate);
  const apiCandidate = aggregate.candidate.fitVerdict === 'not-applicable';
  const quant = apiCandidate ? '-' : (aggregate.candidate.quantization ?? '?');
  const vram = apiCandidate
    ? 'not applicable'
    : aggregate.measuredPeakMib === null
      ? 'not measured'
      : fmtMib(aggregate.measuredPeakMib);
  const predicted =
    apiCandidate || aggregate.predictedPeakMib === null
      ? '-'
      : `${fmtMib(aggregate.predictedPeakMib)}${aggregate.vramDeltaPercent === null ? '' : ` (${fmtSignedPercent(aggregate.vramDeltaPercent)}%)`}`;
  const markers = footnotes.map((f) => f.marker).join(' ');
  return `| ${aggregate.candidate.modelName} | ${quant} | ${quality} | ${pass} | ${ttft} | ${rate} | ${vram} | ${predicted} | ${markers} |`;
}

function environmentSection(run: RunRecord, aggregates: readonly CandidateAggregate[]): string[] {
  const date = new Date(run.createdAtMs).toISOString().slice(0, 10);
  const gpu =
    run.gpuName === null
      ? `not measured (${run.vramUnavailableReason ?? 'no GPU telemetry'})`
      : `${run.gpuName}, driver ${run.driverVersion ?? 'unknown'}`;
  const g = run.generation;
  const drafted = provenanceLabel(run.packProvenance);
  return [
    '## Environment',
    '',
    `- Date: ${date}`,
    `- GPU: ${gpu}`,
    `- Backend: ${run.backendVersion}`,
    `- Task pack: ${run.packName} (scorer ${run.scorerName}), fingerprint \`${run.plan.packFingerprint.slice(0, 12)}\``,
    ...(drafted === null ? [] : [`- **Drafted pack**: ${drafted}`]),
    `- Generation: context ${String(g.context)}, max_tokens ${String(g.max_tokens)}, temperature ${String(g.temperature)}, seed ${String(g.seed)}, ${String(g.runs_per_example)} runs per example`,
    '',
    '| model | quant | params | weights MiB | digest |',
    '| --- | --- | --- | ---: | --- |',
    ...aggregates.map(
      (a) =>
        `| ${a.candidate.modelName} | ${a.candidate.quantization ?? '-'} | ${a.candidate.parameterSize ?? '-'} | ${a.candidate.sizeBytes === 0 ? '-' : fmtMib(a.candidate.sizeBytes / (1024 * 1024))} | \`${a.candidate.digest === a.candidate.modelName ? a.candidate.digest : a.candidate.digest.slice(0, 12)}\` |`,
    ),
  ];
}

function paretoSection(data: ReportData): string[] {
  const { frontier, dominated } = data.pareto;
  if (frontier.length === 0) {
    return ['## Pareto frontier', '', 'Empty: no candidate passed all gate scorers.'];
  }
  return [
    '## Pareto frontier',
    '',
    'Non-dominated on quality, peak memory, and median tokens/sec, among gate-passing candidates:',
    '',
    ...frontier.map(
      (p) =>
        `- **${p.aggregate.candidate.modelName}**: quality ${fmtScore(p.quality)}, ` +
        `${p.vramMib !== null ? `${fmtMib(p.vramMib)} MiB` : p.aggregate.candidate.fitVerdict === 'not-applicable' ? 'memory not applicable' : 'memory not measured'}, ` +
        `${p.tokensPerSecond === null ? 'rate not measured' : `${fmtRate(p.tokensPerSecond)} tok/s`}`,
    ),
    ...(dominated.length > 0
      ? ['', `Dominated: ${dominated.map((p) => p.aggregate.candidate.modelName).join(', ')}.`]
      : []),
  ];
}

function recommendationSection(data: ReportData): string[] {
  const rec = data.recommendation;
  if (rec.kind === 'none') {
    return [
      '## Recommendation',
      '',
      `None. ${rec.reason}. Nearest misses:`,
      '',
      ...rec.nearestMisses.map((m) => `- ${m.aggregate.candidate.modelName}: ${m.reason}`),
    ];
  }
  return [
    '## Recommendation',
    '',
    `**${rec.pick.candidate.modelName}**. ${rec.reason}`,
    '',
    ...rec.runnersUp.map((r) => `- ${r.aggregate.candidate.modelName}: ${r.reason}`),
  ];
}

/**
 * Renders the full markdown report for a run.
 *
 * @param data - Assembled report data.
 * @returns The complete document, ready to publish unedited.
 */
export function renderMarkdownReport(data: ReportData): string {
  const { run } = data;
  const footnotes = footnotesFor(data.aggregates);
  const allNotes = [...footnotes.values()].flat();
  const api = isApiBackend(run.backendVersion);
  const lines: string[] = [
    api
      ? `# quantproof: ${run.packName} via the Anthropic API`
      : `# quantproof: ${run.packName} on ${run.gpuName ?? 'CPU (no GPU telemetry)'}`,
    '',
    api
      ? `Measured results of running the ${run.packName} task pack against ${String(data.aggregates.length)} Claude model${data.aggregates.length === 1 ? '' : 's'} over ${run.backendVersion}. Inference ran on Anthropic hardware: no local GPU, VRAM, or model files were involved, so this table is not comparable to a local-model measurement. Scores are deterministic (scorer: ${run.scorerName}).`
      : `Measured results of running the ${run.packName} task pack against ${String(data.aggregates.length)} local model${data.aggregates.length === 1 ? '' : 's'} via ${run.backendVersion}. Scores are deterministic (scorer: ${run.scorerName}); no numbers below are estimates unless labeled as predictions.`,
    '',
    ...data.notes.map((note) => `> Note: ${note}`),
    ...(data.notes.length > 0 ? [''] : []),
    ...environmentSection(run, data.aggregates),
    '',
    '## Results',
    '',
    '| model | quant | quality (spread) | pass | TTFT ms (spread) | tok/s (spread) | peak memory MiB | predicted MiB (delta) | flags |',
    '| --- | --- | --- | ---: | --- | --- | ---: | --- | --- |',
    ...data.aggregates.map((a) => resultsRow(a, footnotes.get(a) ?? [])),
    ...(allNotes.length > 0 ? ['', ...allNotes.map((f) => `- ${f.marker} ${f.text}`)] : []),
    '',
    ...paretoSection(data),
    '',
    ...recommendationSection(data),
    '',
    '## Methodology',
    '',
    api
      ? `Each example ran ${String(run.generation.runs_per_example)} time${run.generation.runs_per_example === 1 ? '' : 's'} at temperature ${String(run.generation.temperature)} over the streaming Messages API, after one untimed warmup request per model. The API has no sampler seed, so repetitions are compared byte for byte and flagged when they differ. Time to first token includes the network path to the API; token counts come from the API's own usage fields. What is and is not measured on this backend is documented in [docs/methodology.md](docs/methodology.md).`
      : `Each example ran ${String(run.generation.runs_per_example)} time${run.generation.runs_per_example === 1 ? '' : 's'} at temperature ${String(run.generation.temperature)} with a fixed seed, after one untimed warmup per model; models ran strictly one at a time with forced unload and a cooldown between candidates. Quality spread is the range of per-repetition means. ${memorySentence(run)} Measurement limits (polling resolution, warmup policy, determinism caveats, partial-offload detection) are documented in [docs/methodology.md](docs/methodology.md).`,
    '',
    '## Reproduce',
    '',
    '```',
    ...(api ? ['export ANTHROPIC_API_KEY=sk-ant-...'] : []),
    reproductionCommand(run),
    '```',
    '',
  ];
  return lines.join('\n');
}
